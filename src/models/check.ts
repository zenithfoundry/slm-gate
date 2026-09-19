import { footprintReport, warmup } from './footprint.js';
import { handleSlmError } from './helpers.js';
import { isEntryPoint } from '../utils/entry-point.js';

async function check() {
  try {
    await warmup();
    await footprintReport();
  } catch (err: any) {
    if (err.name === 'SlmTimeoutError' || err.message?.includes('fetch failed') || err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
      handleSlmError(err, 'models:check', 'unknown (check config)');
    } else {
      if (err instanceof Error) {
        console.error(`Error: ${err.message}`);
      } else {
        console.error(`Error: ${String(err)}`);
      }
    }
    process.exit(1);
  }
}

if (isEntryPoint(import.meta.url)) {
  check();
}
