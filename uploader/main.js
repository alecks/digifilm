import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import inquirer from "inquirer";
import { glob } from "glob";
import sizeOf from "image-size";
import Cloudflare from "cloudflare";

dotenv.config();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID;

if (
  !R2_ACCOUNT_ID ||
  !R2_ACCESS_KEY_ID ||
  !R2_SECRET_ACCESS_KEY ||
  !R2_BUCKET_NAME
) {
  console.error(
    "Missing R2 environment variables. Please check your .env file or system environment.",
  );
  process.exit(1);
}

const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const s3Client = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

let cloudflareClient = null;
if (CLOUDFLARE_API_TOKEN) {
  cloudflareClient = new Cloudflare({
    apiToken: CLOUDFLARE_API_TOKEN,
  });
}

async function getKvMetadata(albumId) {
  if (!cloudflareClient || !KV_NAMESPACE_ID) {
    return null;
  }

  const kvKey = `album:${albumId}`;

  try {
    const value = await cloudflareClient.kv.namespaces.values.get(
      KV_NAMESPACE_ID,
      kvKey,
      {
        account_id: R2_ACCOUNT_ID,
      },
    );

    if (!value) {
      return null;
    }

    const content = await value.json();
    return content;
  } catch (error) {
    if (error.status === 404 || error.message?.includes("10009")) {
      return null;
    }
    console.warn("Warning: Error fetching KV metadata:", error.message);
    return null;
  }
}

async function updateKvMetadata(albumId, metadata) {
  if (!cloudflareClient || !KV_NAMESPACE_ID) {
    console.error(
      "Missing Cloudflare credentials (CLOUDFLARE_API_TOKEN, KV_NAMESPACE_ID)",
    );
    return false;
  }

  const kvKey = `album:${albumId}`;

  try {
    await cloudflareClient.kv.namespaces.values.update(KV_NAMESPACE_ID, kvKey, {
      account_id: R2_ACCOUNT_ID,
      value: JSON.stringify(metadata),
    });

    console.log(`✅ Successfully updated KV metadata for album:${albumId}`);
    return true;
  } catch (error) {
    console.error("Error updating KV metadata:", error.message);
    return false;
  }
}

async function deleteKvMetadata(albumId) {
  if (!cloudflareClient || !KV_NAMESPACE_ID) {
    console.warn("Missing Cloudflare credentials, skipping KV deletion");
    return false;
  }

  const kvKey = `album:${albumId}`;

  try {
    await cloudflareClient.kv.namespaces.values.delete(KV_NAMESPACE_ID, kvKey, {
      account_id: R2_ACCOUNT_ID,
    });

    console.log(`✅ Successfully deleted KV metadata for album:${albumId}`);
    return true;
  } catch (error) {
    if (error.status === 404 || error.message?.includes("10009")) {
      console.log(`No KV metadata found for album:${albumId}`);
      return true;
    }
    console.error("Error deleting KV metadata:", error.message);
    return false;
  }
}

async function listR2Images(albumId) {
  try {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const command = new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      Prefix: `${albumId}/`,
    });

    const response = await s3Client.send(command);
    return (response.Contents || [])
      .filter((obj) => /\.(jpeg|jpg|png|gif|webp|avif)$/i.test(obj.Key))
      .map((obj) => obj.Key);
  } catch (error) {
    console.warn("Warning: Could not list existing R2 images:", error.message);
    return [];
  }
}

async function deleteR2Images(albumId) {
  try {
    const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const imageKeys = await listR2Images(albumId);

    if (imageKeys.length === 0) {
      console.log("No images found to delete.");
      return true;
    }

    console.log(`Found ${imageKeys.length} images to delete...`);

    // R2 allows batch deletion of up to 1000 objects at once
    const batchSize = 1000;
    let deletedCount = 0;

    for (let i = 0; i < imageKeys.length; i += batchSize) {
      const batch = imageKeys.slice(i, i + batchSize);

      const command = new DeleteObjectsCommand({
        Bucket: R2_BUCKET_NAME,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: false,
        },
      });

      const response = await s3Client.send(command);
      deletedCount += response.Deleted?.length || 0;

      if (response.Errors && response.Errors.length > 0) {
        console.error("Some deletions failed:");
        response.Errors.forEach((error) => {
          console.error(`  - ${error.Key}: ${error.Message}`);
        });
      }
    }

    console.log(`✅ Successfully deleted ${deletedCount} images from R2`);
    return true;
  } catch (error) {
    console.error("Error deleting R2 images:", error.message);
    return false;
  }
}

async function deleteAlbum(albumId) {
  console.log(`\n--- Deleting album: "${albumId}" ---`);

  const existingMetadata = await getKvMetadata(albumId);
  const existingImages = await listR2Images(albumId);

  if (!existingMetadata && existingImages.length === 0) {
    console.log("Album not found (no metadata or images exist).");
    return;
  }

  console.log("\n⚠️  ALBUM DELETION SUMMARY:");
  if (existingMetadata) {
    console.log(`  - KV Metadata: Found (Title: "${existingMetadata.title}")`);
  } else {
    console.log(`  - KV Metadata: Not found`);
  }
  console.log(`  - Images in R2: ${existingImages.length}`);

  const { confirmDelete } = await inquirer.prompt({
    type: "confirm",
    name: "confirmDelete",
    message: `Are you ABSOLUTELY SURE you want to delete this album? This action cannot be undone!`,
    default: false,
  });

  if (!confirmDelete) {
    console.log("Deletion cancelled.");
    return;
  }

  // Delete R2 images first
  if (existingImages.length > 0) {
    await deleteR2Images(albumId);
  }

  // Delete KV metadata
  if (existingMetadata) {
    await deleteKvMetadata(albumId);
  }

  console.log(`\n✅ Album "${albumId}" has been completely deleted.`);
}

async function manageAlbum(albumId) {
  console.log(`\n--- Working with album: "${albumId}" ---`);

  // Handle KV metadata
  const { manageMetadata } = await inquirer.prompt({
    type: "confirm",
    name: "manageMetadata",
    message: "Would you like to update/add KV metadata for this album?",
    default: true,
  });

  if (manageMetadata) {
    console.log("\n--- Fetching existing metadata ---");
    const existingMetadata = await getKvMetadata(albumId);

    if (existingMetadata) {
      console.log("Current metadata:");
      console.log(JSON.stringify(existingMetadata, null, 2));
    } else {
      console.log("No existing metadata found.");
    }

    // Get existing R2 images for cover selection
    const existingImages = await listR2Images(albumId);
    const imageFilenames = existingImages.map((key) =>
      key.replace(`${albumId}/`, ""),
    );

    const metadataQuestions = [
      {
        type: "input",
        name: "title",
        message: "Album title:",
        default: existingMetadata?.title || albumId.replace(/-/g, " "),
      },
      {
        type: "input",
        name: "description",
        message: "Album description:",
        default: existingMetadata?.description || "",
      },
    ];

    // Add cover selection if images exist
    if (imageFilenames.length > 0) {
      metadataQuestions.push({
        type: "list",
        name: "coverImage",
        message: "Select cover image:",
        choices: imageFilenames.map((filename) => ({
          name: filename,
          value: `${albumId}/${filename}`,
        })),
        default: existingMetadata?.cover_key,
      });
    } else {
      metadataQuestions.push({
        type: "input",
        name: "coverImage",
        message: "Cover image key (format: album-id/filename.jpg):",
        default: existingMetadata?.cover_key || `${albumId}/cover.jpg`,
      });
    }

    metadataQuestions.push(
      {
        type: "confirm",
        name: "allowDownloads",
        message: "Allow downloads for this album?",
        default: existingMetadata?.allow_downloads ?? true,
      },
      {
        type: "confirm",
        name: "private",
        message: "Make this album private?",
        default: existingMetadata?.private ?? false,
      },
    );

    const metadata = await inquirer.prompt(metadataQuestions);

    const kvMetadata = {
      title: metadata.title,
      description: metadata.description,
      cover_key: metadata.coverImage,
      allow_downloads: metadata.allowDownloads,
      private: metadata.private,
    };

    console.log("\nMetadata to be saved:");
    console.log(JSON.stringify(kvMetadata, null, 2));

    const { confirmKv } = await inquirer.prompt({
      type: "confirm",
      name: "confirmKv",
      message: "Save this metadata to KV store?",
      default: true,
    });

    if (confirmKv) {
      await updateKvMetadata(albumId, kvMetadata);
    }
  }

  // Handle image uploads
  const { uploadImages } = await inquirer.prompt({
    type: "confirm",
    name: "uploadImages",
    message: "Would you like to upload images for this album?",
    default: true,
  });

  if (!uploadImages) {
    console.log("Done!");
    return;
  }

  // Get folder selection
  const { localBaseDir } = await inquirer.prompt({
    type: "input",
    name: "localBaseDir",
    message: "Enter the BASE path where your local image folders are located:",
    default: path.resolve(process.cwd(), "./local-albums"),
    validate: async (input) => {
      try {
        const stats = await fs.stat(input);
        return stats.isDirectory() || "Please enter a valid directory path.";
      } catch {
        return "Directory does not exist or is not accessible.";
      }
    },
  });

  const allEntriesInBaseDir = await glob("*", {
    cwd: localBaseDir,
    dot: false,
    maxDepth: 1,
    absolute: false,
  });
  const albumFolders = [];
  for (const entry of allEntriesInBaseDir) {
    const entryPath = path.join(localBaseDir, entry);
    const stats = await fs.stat(entryPath);
    if (stats.isDirectory()) {
      albumFolders.push(entry);
    }
  }

  if (albumFolders.length === 0) {
    console.error(`No folders found in "${localBaseDir}".`);
    return;
  }

  const { selectedFolder } = await inquirer.prompt({
    type: "list",
    name: "selectedFolder",
    message: "Select the folder containing images to upload:",
    choices: albumFolders,
  });

  const localFolderPath = path.join(localBaseDir, selectedFolder);

  console.log(
    `\nUploading images from "${selectedFolder}" to album "${albumId}"`,
  );
  console.log(`Local Path: ${localFolderPath}`);
  console.log("-----------------------------------");

  const { confirmUpload } = await inquirer.prompt({
    type: "confirm",
    name: "confirmUpload",
    message: `Proceed with uploading images to R2 under prefix "${albumId}"?`,
    default: true,
  });

  if (!confirmUpload) {
    console.log("Upload cancelled.");
    return;
  }

  // Upload images
  const files = await fs.readdir(localFolderPath);
  let uploadedCount = 0;
  const imageFiles = files.filter((filename) =>
    /\.(jpeg|jpg|png|gif|webp|avif)$/i.test(filename),
  );

  if (imageFiles.length === 0) {
    console.warn(`No image files found in "${localFolderPath}".`);
    return;
  }

  for (const filename of imageFiles) {
    const filePath = path.join(localFolderPath, filename);
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
        throw new Error("Could not get valid dimensions from image-size.");
      }
    } catch (dimError) {
      console.warn(
        `  Warning: Could not determine dimensions for ${filename}. Using defaults.`,
      );
      width = 1200;
      height = 800; // Default landscape
    }

    const r2Key = `${albumId}/${filename}`;
    const putCommand = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: r2Key,
      Body: fileBuffer,
      ContentType: `image/${fileExtension.substring(1)}`,
      Metadata: {
        width: width.toString(),
        height: height.toString(),
      },
    });

    try {
      await s3Client.send(putCommand);
      console.log(
        `  ✅ Uploaded ${filename} to R2 with metadata ${width}x${height}`,
      );
      uploadedCount++;
    } catch (uploadError) {
      console.error(
        `  ❌ ERROR: Failed to upload ${filename}:`,
        uploadError.message,
      );
    }
  }

  console.log(`\n--- Upload Complete ---`);
  console.log(`Total images processed: ${imageFiles.length}`);
  console.log(`Successfully uploaded: ${uploadedCount}`);
  console.log(`Failed uploads: ${imageFiles.length - uploadedCount}`);
}

async function main() {
  console.log("--- Digifilm Album CLI ---");

  // Step 1: Choose action
  const { action } = await inquirer.prompt({
    type: "list",
    name: "action",
    message: "What would you like to do?",
    choices: [
      { name: "Create/Update Album", value: "manage" },
      { name: "Delete Album", value: "delete" },
    ],
  });

  // Step 2: Get album ID
  const { albumId } = await inquirer.prompt({
    type: "input",
    name: "albumId",
    message: "Enter the album ID:",
    validate: (input) => {
      if (!input.trim()) return "Album ID is required";
      if (!/^[a-z0-9-]+$/.test(input.trim()))
        return "Album ID must contain only lowercase letters, numbers, and hyphens";
      return true;
    },
    filter: (input) => input.trim().toLowerCase(),
  });

  if (action === "delete") {
    await deleteAlbum(albumId);
  } else {
    await manageAlbum(albumId);
  }

  console.log("\nDone!");
}

main();
