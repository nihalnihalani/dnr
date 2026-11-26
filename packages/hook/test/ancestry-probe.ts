// Spawned by ancestry.test.ts: prints the real human-guard result for this process.
import { humanGuard } from '../src/ancestry';

process.stdout.write(JSON.stringify(humanGuard()));
