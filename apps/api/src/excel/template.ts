import {
  CURRENCY_CODES,
  EMIRATES,
  HEADER_COLUMNS,
  INVOICE_TYPES,
  LINE_COLUMNS,
  LOOKUPS_SHEET,
  PAYMENT_MEANS,
  UOMS,
  VAT_CATEGORIES,
  type ColumnSpec,
} from '@uae/domain';
import ExcelJS from 'exceljs';

/**
 * Per-tenant template generation.
 *
 * Rather than serving a static file, the workbook is built with the merchant's
 * own supplier TRN and legal name already filled in and locked. Those two
 * columns are otherwise a reliable source of upload errors — people retype
 * their own TRN wrongly, or paste a group company's — and an error that can be
 * designed out is better than an error caught well.
 */

export interface TemplateOptions {
  supplierTrn: string;
  supplierName: string;
  /** Number of pre-formatted blank rows to prepare. */
  headerRows?: number;
  lineRows?: number;
}

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A5F' },
};

const DERIVED_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F5F9' },
};

const LOCKED_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFEF9C3' },
};

function styleHeaderRow(sheet: ExcelJS.Worksheet, columns: ColumnSpec[]) {
  const row = sheet.getRow(1);
  columns.forEach((spec, index) => {
    const cell = row.getCell(index + 1);
    cell.value = spec.header;
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F172A' } } };

    // The hint lives in a cell comment so the workbook explains itself without
    // a separate instructions sheet nobody reads.
    const requirement =
      spec.required === 'yes'
        ? 'Required.'
        : spec.required === 'conditional'
          ? 'Required in some cases.'
          : spec.required === 'derived'
            ? 'Calculated automatically — do not edit.'
            : 'Optional.';
    cell.note = `${requirement}\n${spec.hint}`;

    sheet.getColumn(index + 1).width = spec.width;
  });

  row.height = 22;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export async function buildTemplate(options: TemplateOptions): Promise<Buffer> {
  const headerRows = options.headerRows ?? 200;
  const lineRows = options.lineRows ?? 500;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'UAE E-Invoicing Middleware';
  workbook.created = new Date();

  // --- Ref_Lookups ---------------------------------------------------------
  // Written first so the other sheets' data validations can reference it.
  const lookups = workbook.addWorksheet(LOOKUPS_SHEET);
  const lookupColumns: { header: string; values: string[] }[] = [
    { header: 'Invoice_Type_Code', values: Object.keys(INVOICE_TYPES) },
    { header: 'Invoice_Type_Desc', values: Object.values(INVOICE_TYPES).map((t) => t.label) },
    { header: 'VAT_Category_Code', values: Object.keys(VAT_CATEGORIES) },
    { header: 'VAT_Category_Desc', values: Object.values(VAT_CATEGORIES).map((v) => v.label) },
    { header: 'Payment_Means_Code', values: Object.keys(PAYMENT_MEANS) },
    { header: 'Payment_Means_Desc', values: Object.values(PAYMENT_MEANS) },
    { header: 'Emirate_Name', values: [...EMIRATES] },
    { header: 'UOM_Code', values: Object.keys(UOMS) },
    { header: 'UOM_Desc', values: Object.values(UOMS) },
    { header: 'Currency_Code', values: [...CURRENCY_CODES] },
  ];

  lookupColumns.forEach((column, index) => {
    const col = index + 1;
    const headerCell = lookups.getRow(1).getCell(col);
    headerCell.value = column.header;
    headerCell.font = { bold: true };
    headerCell.fill = HEADER_FILL;
    headerCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    lookups.getColumn(col).width = Math.max(18, column.header.length + 2);

    column.values.forEach((value, rowIndex) => {
      lookups.getRow(rowIndex + 2).getCell(col).value = value;
    });
  });

  const colLetter = (index: number) => lookups.getColumn(index + 1).letter;
  const range = (index: number, count: number) =>
    `${LOOKUPS_SHEET}!$${colLetter(index)}$2:$${colLetter(index)}$${count + 1}`;

  // --- Invoice_Header ------------------------------------------------------
  const header = workbook.addWorksheet('Invoice_Header');
  styleHeaderRow(header, HEADER_COLUMNS);

  for (let row = 2; row <= headerRows + 1; row++) {
    // Supplier identity is pre-filled and visually marked as fixed.
    const trnCell = header.getCell(`G${row}`);
    trnCell.value = options.supplierTrn;
    trnCell.numFmt = '@'; // text, so a 15-digit TRN is never shown as 1.00294E+14
    trnCell.fill = LOCKED_FILL;

    const nameCell = header.getCell(`H${row}`);
    nameCell.value = options.supplierName;
    nameCell.fill = LOCKED_FILL;

    header.getCell(`E${row}`).value = 'AED';
    header.getCell(`F${row}`).value = 1;
    header.getCell(`I${row}`).numFmt = '@';
    header.getCell(`C${row}`).numFmt = '@';
    header.getCell(`D${row}`).numFmt = '@';

    header.getCell(`B${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [range(0, Object.keys(INVOICE_TYPES).length)],
      showErrorMessage: true,
      errorTitle: 'Invalid invoice type',
      error: 'Choose 380 (Tax), 388 (Simplified), 381 (Credit) or 383 (Debit).',
    };

    header.getCell(`E${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [range(9, CURRENCY_CODES.length)],
      showErrorMessage: true,
    };

    header.getCell(`K${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [range(6, EMIRATES.length)],
      showErrorMessage: true,
      errorTitle: 'Invalid emirate',
      error: 'Choose one of the seven emirates.',
    };

    header.getCell(`N${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [range(4, Object.keys(PAYMENT_MEANS).length)],
      showErrorMessage: true,
    };

    // Buyer TRN: 15 digits starting with 1, checked in the spreadsheet itself
    // so the most common error never reaches upload. Blank is allowed because
    // a B2C simplified invoice legitimately has none.
    header.getCell(`I${row}`).dataValidation = {
      type: 'custom',
      allowBlank: true,
      formulae: [`=OR(I${row}="",AND(ISNUMBER(VALUE(I${row})),LEN(I${row})=15,LEFT(I${row},1)="1"))`],
      showErrorMessage: true,
      errorTitle: 'Invalid TRN',
      error: 'A UAE TRN is exactly 15 digits and starts with 1. Leave blank for a B2C sale.',
    };
  }

  // --- Invoice_Line_Items --------------------------------------------------
  const lines = workbook.addWorksheet('Invoice_Line_Items');
  styleHeaderRow(lines, LINE_COLUMNS);

  for (let row = 2; row <= lineRows + 1; row++) {
    lines.getCell(`F${row}`).value = 'PCE';
    lines.getCell(`I${row}`).value = 'S';
    lines.getCell(`H${row}`).value = 0;

    lines.getCell(`F${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [range(7, Object.keys(UOMS).length)],
      showErrorMessage: true,
    };

    lines.getCell(`I${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [range(2, Object.keys(VAT_CATEGORIES).length)],
      showErrorMessage: true,
      errorTitle: 'Invalid VAT category',
      error: 'Choose S (standard 5%), Z (zero), E (exempt) or O (out of scope).',
    };

    // The derived columns. Formulas guard against blank rows so an unused row
    // shows nothing rather than 0.00, which would read as a free line item.
    const derived: Record<string, string> = {
      [`J${row}`]: `IF(I${row}="","",IF(I${row}="S",5,0))`,
      [`K${row}`]: `IF(OR(E${row}="",G${row}=""),"",ROUND((E${row}*G${row})-IF(H${row}="",0,H${row}),2))`,
      [`L${row}`]: `IF(K${row}="","",ROUND(K${row}*(J${row}/100),2))`,
      [`M${row}`]: `IF(K${row}="","",K${row}+L${row})`,
    };

    for (const [address, formula] of Object.entries(derived)) {
      const cell = lines.getCell(address);
      cell.value = { formula, result: undefined } as ExcelJS.CellFormulaValue;
      cell.fill = DERIVED_FILL;
      cell.numFmt = address.startsWith('J') ? '0.00' : '#,##0.00';
    }

    lines.getCell(`E${row}`).numFmt = '#,##0.0000';
    lines.getCell(`G${row}`).numFmt = '#,##0.0000';
    lines.getCell(`H${row}`).numFmt = '#,##0.00';
    lines.getCell(`A${row}`).numFmt = '@';
  }

  // Protect the calculated columns and the pre-filled supplier identity.
  // Unlocking everything else keeps the sheet usable without a password prompt
  // on every cell the user is meant to fill in.
  for (let row = 2; row <= lineRows + 1; row++) {
    for (const col of ['J', 'K', 'L', 'M']) {
      lines.getCell(`${col}${row}`).protection = { locked: true };
    }
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']) {
      lines.getCell(`${col}${row}`).protection = { locked: false };
    }
  }

  for (let row = 2; row <= headerRows + 1; row++) {
    for (const col of ['G', 'H']) {
      header.getCell(`${col}${row}`).protection = { locked: true };
    }
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'I', 'J', 'K', 'L', 'M', 'N']) {
      header.getCell(`${col}${row}`).protection = { locked: false };
    }
  }

  // Sheet protection with no password: it is a guard rail against accidental
  // edits to formula columns, not a security control. A password would only
  // generate support calls.
  await lines.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatCells: false });
  await header.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatCells: false });

  lookups.state = 'veryHidden';

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
