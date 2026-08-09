import '@testing-library/jest-dom/vitest';
import { beforeAll } from 'vitest';

/**
 * jsdom gives every element a zero size and has no ResizeObserver, so
 * @tanstack/react-virtual measures a viewport of 0px and renders no rows at
 * all. Without these shims the grid tests would be asserting against an empty
 * container while appearing to run.
 */
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  }

  // A viewport tall enough for the whole fixture, so virtualisation does not
  // window rows out of the assertions.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 1200;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 1600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 44;
    },
  });

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 44,
      right: 1600,
      width: 1600,
      height: 44,
      toJSON: () => ({}),
    } as DOMRect;
  };

  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
});
