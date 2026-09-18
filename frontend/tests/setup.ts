import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library does not unmount between tests on its own outside of globals
// mode, and a leaked tree makes the next test's queries ambiguous in confusing ways.
afterEach(() => {
  cleanup();
});
