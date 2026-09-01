const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env file in the root directory
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

const {
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_ACCOUNT_ID
} = process.env;

// Check if all required environment variables are present
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) {
  console.error("❌ Error: Missing required R2 environment variables in .env file.");
  console.error("Please ensure R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_ACCOUNT_ID are set.");
  process.exit(1);
}

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function clearBucket() {
  console.log(`🗑️ Deleting all files from R2 bucket: ${R2_BUCKET_NAME}...`);
  try {
    let isTruncated = true;
    let continuationToken = undefined;

    while (isTruncated) {
      const listCommand = new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        ContinuationToken: continuationToken,
      });

      const listResult = await s3Client.send(listCommand);

      if (!listResult.Contents || listResult.Contents.length === 0) {
        console.log("ℹ️ Bucket is already empty.");
        break;
      }

      const objectsToDelete = listResult.Contents.map((item) => ({ Key: item.Key }));
      
      const deleteCommand = new DeleteObjectsCommand({
        Bucket: R2_BUCKET_NAME,
        Delete: { Objects: objectsToDelete },
      });

      await s3Client.send(deleteCommand);
      console.log(`✅ Deleted ${objectsToDelete.length} objects...`);

      isTruncated = listResult.IsTruncated;
      continuationToken = listResult.NextContinuationToken;
    }
    
    console.log("✅ Successfully cleared R2 bucket.");
  } catch (error) {
    console.error("❌ Failed to clear R2 bucket.");
    console.error(error);
    process.exit(1);
  }
}

clearBucket();
