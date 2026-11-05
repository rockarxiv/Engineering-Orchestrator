import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Same reason as the desktop renderer setup: Testing Library only
// auto-cleans under `globals: true`, which this repository doesn't use.
afterEach(cleanup);
