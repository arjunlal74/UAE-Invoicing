import { recalcInvoice } from './calc.js';
import {
  BASE_CURRENCY,
  EMIRATES,
  UOM_CODES,
  VAT_CATEGORIES,
  expectedVatRate,
  type VatCategoryCode,
} from './codes.js';
import type { StagedInvoice } from './types.js';

/**
 * "Auto-Fix Common Defaults" — the batch-summary button in the staging grid.
 *
 * Deliberately conservative. It only corrects things where there is exactly one
 * defensible value, and it never invents data: it will not guess a TRN, a buyer
 * name, a date, or an amount. Those are the user's to fix, because a plausible
 * wrong guess that sails through validation is far worse than a red cell.
 *
 * Every change is reported so the UI can show what it touched and the audit
 * trail can record it.
 */

export interface AutoFixChange {
  invoiceId: string;
  lineId?: string;
  field: string;
  from: string;
  to: string;
  reason: string;
}

export interface AutoFixResult {
  invoices: StagedInvoice[];
  changes: AutoFixChange[];
}

function titleCaseEmirate(value: string): string | null {
  const normalised = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const aliases: Record<string, string> = {
    dubai: 'Dubai',
    dxb: 'Dubai',
    'abu dhabi': 'Abu Dhabi',
    abudhabi: 'Abu Dhabi',
    auh: 'Abu Dhabi',
    sharjah: 'Sharjah',
    shj: 'Sharjah',
    ajman: 'Ajman',
    'ras al khaimah': 'Ras Al Khaimah',
    'ras al-khaimah': 'Ras Al Khaimah',
    rak: 'Ras Al Khaimah',
    fujairah: 'Fujairah',
    fuj: 'Fujairah',
    'umm al quwain': 'Umm Al Quwain',
    'umm al-quwain': 'Umm Al Quwain',
    uaq: 'Umm Al Quwain',
  };
  const match = aliases[normalised];
  if (match) return match;
  const exact = EMIRATES.find((e) => e.toLowerCase() === normalised);
  return exact ?? null;
}

export function autoFix(invoices: StagedInvoice[]): AutoFixResult {
  const changes: AutoFixChange[] = [];

  const fixed = invoices.map((invoice) => {
    const next: StagedInvoice = { ...invoice, lines: invoice.lines.map((l) => ({ ...l })) };
    const record = (field: string, from: string, to: string, reason: string, lineId?: string) => {
      changes.push({ invoiceId: invoice.id, lineId, field, from, to, reason });
    };

    // Currency: blank means AED, which is the template default.
    if (!next.currency?.trim()) {
      record('currency', next.currency ?? '', BASE_CURRENCY, 'Blank currency defaults to AED');
      next.currency = BASE_CURRENCY;
    } else {
      const upper = next.currency.trim().toUpperCase();
      if (upper !== next.currency) {
        record('currency', next.currency, upper, 'Currency codes are uppercase');
        next.currency = upper;
      }
    }

    // FX rate is 1 for AED invoices; anything else the user must supply.
    if (next.currency === BASE_CURRENCY) {
      const fx = next.fxRate?.trim();
      if (!fx || fx === '0') {
        record('fxRate', fx ?? '', '1.000000', 'AED invoices use an exchange rate of 1');
        next.fxRate = '1.000000';
      }
    }

    // Issue time: the FTA requires one, and midnight is the conventional
    // stand-in when a source system only records a date.
    if (!next.issueTime?.trim()) {
      record('issueTime', '', '00:00:00', 'Missing issue time defaults to midnight');
      next.issueTime = '00:00:00';
    } else {
      // HH:MM -> HH:MM:00
      const t = next.issueTime.trim();
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        record('issueTime', t, `${t}:00`, 'Padded to HH:MM:SS');
        next.issueTime = `${t}:00`;
      }
    }

    // TRNs pasted from spreadsheets frequently carry spaces or hyphens.
    for (const field of ['supplierTrn', 'buyerTrn'] as const) {
      const raw = next[field];
      if (!raw) continue;
      const stripped = raw.replace(/[\s-]/g, '');
      if (stripped !== raw) {
        record(field, raw, stripped, 'Removed spaces and hyphens from TRN');
        next[field] = stripped;
      }
    }

    // Emirate spelling and casing.
    if (next.buyerEmirate?.trim()) {
      const canonical = titleCaseEmirate(next.buyerEmirate);
      if (canonical && canonical !== next.buyerEmirate) {
        record('buyerEmirate', next.buyerEmirate, canonical, 'Normalised emirate name');
        next.buyerEmirate = canonical;
      }
    }

    // Invoice type: tolerate the label instead of the code.
    const typeRaw = next.invoiceType?.trim() ?? '';
    const typeAliases: Record<string, string> = {
      tax: '380',
      'tax invoice': '380',
      b2b: '380',
      simplified: '388',
      'simplified tax invoice': '388',
      b2c: '388',
      credit: '381',
      'credit note': '381',
      debit: '383',
      'debit note': '383',
    };
    const typeAlias = typeAliases[typeRaw.toLowerCase()];
    if (typeAlias) {
      record('invoiceType', typeRaw, typeAlias, 'Converted invoice type description to its code');
      next.invoiceType = typeAlias;
    }

    for (const line of next.lines) {
      // UOM casing.
      if (line.uom?.trim()) {
        const upper = line.uom.trim().toUpperCase();
        if (upper !== line.uom && (UOM_CODES as readonly string[]).includes(upper)) {
          record('uom', line.uom, upper, 'Unit of measure codes are uppercase', line.id);
          line.uom = upper;
        }
      } else {
        record('uom', '', 'PCE', 'Blank unit of measure defaults to pieces', line.id);
        line.uom = 'PCE';
      }

      // VAT category casing.
      if (line.vatCategory?.trim()) {
        const upper = line.vatCategory.trim().toUpperCase();
        if (upper !== line.vatCategory) {
          record('vatCategory', line.vatCategory, upper, 'VAT category codes are uppercase', line.id);
          line.vatCategory = upper;
        }
      }

      // VAT rate always follows from the category — this is the single most
      // common upload error and the one the template's formula exists to stop.
      const category = line.vatCategory as VatCategoryCode;
      if (category in VAT_CATEGORIES) {
        const required = expectedVatRate(category).toFixed(2);
        const supplied = line.vatRate?.trim() ?? '';
        if (supplied !== required) {
          record(
            'vatRate',
            supplied,
            required,
            `VAT category ${category} always carries ${required}%`,
            line.id,
          );
          line.vatRate = required;
        }
      }

      if (!line.lineDiscount?.trim()) {
        record('lineDiscount', '', '0.00', 'Blank discount defaults to zero', line.id);
        line.lineDiscount = '0.00';
      }
    }

    // Renumber lines only when they are actually broken (duplicated or blank);
    // otherwise a user's deliberate numbering is preserved.
    const numbers = next.lines.map((l) => l.lineNumber?.trim() ?? '');
    const hasBlank = numbers.some((n) => n === '');
    const hasDupes = new Set(numbers).size !== numbers.length;
    if (hasBlank || hasDupes) {
      next.lines.forEach((line, i) => {
        const to = String(i + 1);
        if (line.lineNumber !== to) {
          record('lineNumber', line.lineNumber ?? '', to, 'Renumbered lines sequentially', line.id);
          line.lineNumber = to;
        }
      });
    }

    return recalcInvoice(next);
  });

  return { invoices: fixed, changes };
}
