/// <reference types="vitest/globals" />

/**
 * Registers the jest-dom matchers with Vitest's `expect` at the type level.
 * The runtime side is imported in `tests/setup.ts`; this is what makes
 * `toBeInTheDocument` type-check.
 */
import '@testing-library/jest-dom/vitest';
