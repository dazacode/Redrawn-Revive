// Runs before every test file: point runtime data at a throwaway directory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "redrawn-test-"));
