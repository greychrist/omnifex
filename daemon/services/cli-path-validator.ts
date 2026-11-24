import fs from 'node:fs';

export type ValidateCliPathResult = { ok: true } | { ok: false; error: string };

export function validateCliPath(input: string | null | undefined): ValidateCliPathResult {
  if (input == null || input === '') return { ok: true };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input);
  } catch {
    return { ok: false, error: `Path not found: ${input}` };
  }
  if (!stat.isFile()) return { ok: false, error: `Not a regular file: ${input}` };
  try {
    fs.accessSync(input, fs.constants.X_OK);
  } catch {
    return { ok: false, error: `Not executable: ${input}` };
  }
  return { ok: true };
}
