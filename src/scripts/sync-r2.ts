import * as dotenv from 'dotenv';
import { saveStateToR2 } from '../libs/r2-sync';

dotenv.config();

async function run() {
  console.log('🔄 Syncing local auth_info state to Cloudflare R2...');
  const result = await saveStateToR2();
  console.log(result.success ? '✅ Success:' : '❌ Failure:', result.message);
}

run();
