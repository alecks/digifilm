import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import inquirer from 'inquirer';
import { glob } from 'glob';
import sizeOf from 'image-size';

dotenv.config();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
  console.error("Missing R2 environment variables. Please check your .env file or system environment.");
  process.exit(1);
}

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const s3Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function main() {
  console.log("--- Digifilm R2 Album Uploader ---");

  const { localBaseDir } = await inquirer.prompt({
    type: 'input',
    name: 'localBaseDir',
    message: 'Enter the BASE path where your local album folders are located:',
    default: path.resolve(process.cwd(), './local-albums'),
    validate: async (input) => {
      try {
        const stats = await fs.stat(input);
        return stats.isDirectory() || 'Please enter a valid directory path.';
      } catch {
        return 'Directory does not exist or is not accessible.';
      }
    }
  });

  const allEntriesInBaseDir = await glob('*', { cwd: localBaseDir, dot: false, maxDepth: 1, absolute: false });
  const albumFolders = [];
  for (const entry of allEntriesInBaseDir) {
    const entryPath = path.join(localBaseDir, entry);
    const stats = await fs.stat(entryPath);
    if (stats.isDirectory()) {
      albumFolders.push(entry);
    }
  }

  if (albumFolders.length === 0) {
    console.error(`No album folders found in "${localBaseDir}". Please create subfolders for each album.`);
    process.exit(1);
  }

  const choices = albumFolders.map(folderName => {
    const id = folderName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
    return { name: `"${folderName}" (ID: ${id})`, value: { folderName, id } };
  });

  const { selectedAlbum } = await inquirer.prompt({
    type: 'list',
    name: 'selectedAlbum',
    message: 'Select the album folder to upload:',
    choices: choices,
  });

  const localAlbumName = selectedAlbum.folderName;
  const albumId = selectedAlbum.id;
  const localAlbumPath = path.join(localBaseDir, localAlbumName);

  console.log(`\nSelected Album: "${localAlbumName}" (R2 ID: "${albumId}")`);
  console.log(`Local Path: ${localAlbumPath}`);
  console.log("-----------------------------------");

  const { confirmUpload } = await inquirer.prompt({
    type: 'confirm',
    name: 'confirmUpload',
    message: `Proceed with uploading images from "${localAlbumName}" to R2 under prefix "${albumId}"?`,
    default: true
  });

  if (!confirmUpload) {
    console.log("Upload cancelled.");
    process.exit(0);
  }

  const files = await fs.readdir(localAlbumPath);
  let uploadedCount = 0;
  const imageFiles = files.filter(filename => /\.(jpeg|jpg|png|gif|webp|avif)$/i.test(filename));

  if (imageFiles.length === 0) {
    console.warn(`No image files found in "${localAlbumPath}". Exiting.`);
    process.exit(0);
  }

  for (const filename of imageFiles) {
    const filePath = path.join(localAlbumPath, filename);
    const fileExtension = path.extname(filename).toLowerCase();

    console.log(`Processing ${filename}...`);
    const fileBuffer = await fs.readFile(filePath);

    let width = 0;
    let height = 0;

    try {
      const dimensions = sizeOf(fileBuffer);
      width = dimensions.width || 0;
      height = dimensions.height || 0;
      if (width > 0 && height > 0) {
        console.log(`  Dimensions: ${width}x${height}`);
      } else {
        throw new Error('Could not get valid dimensions from image-size.');
      }
    } catch (dimError) {
      console.warn(`  Warning: Could not determine dimensions for ${filename}. Using default/placeholder.`, dimError.message);
      if (filename.toLowerCase().includes('portrait')) { width = 800; height = 1200; }
      else if (filename.toLowerCase().includes('square')) { width = 1000; height = 1000; }
      else { width = 1200; height = 800; } // Default landscape
    }

    const r2Key = `${albumId}/${filename}`;
    const putCommand = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileBuffer,
      ContentType: `image/${fileExtension.substring(1)}`,
      Metadata: {
        'width': width.toString(),
        'height': height.toString(),
      },
    });

    try {
      await s3Client.send(putCommand);
      console.log(`  Uploaded ${filename} to R2 with metadata ${width}x${height}`);
      uploadedCount++;
    } catch (uploadError) {
      console.error(`  ERROR: Failed to upload ${filename}:`, uploadError.message);
    }
  }

  console.log(`\n--- Upload Complete ---`);
  console.log(`Total images processed: ${imageFiles.length}`);
  console.log(`Successfully uploaded: ${uploadedCount}`);
  console.log(`Failed uploads: ${imageFiles.length - uploadedCount}`);

  const albumKvData = {
    title: localAlbumName.replace(/[-_]/g, ' '), // Default title from folder name
    description: `A collection of ${uploadedCount} photos from ${localAlbumName}.`,
    cover_key: `${albumId}/${imageFiles[0] || 'default-cover.jpg'}`, // First image as cover, or default
  };

  console.log("\n--- KV Update Reminder ---");
  console.log("Consider updating your KV store with album metadata. Example data:");
  console.log(JSON.stringify(albumKvData, null, 2));
}

main();
