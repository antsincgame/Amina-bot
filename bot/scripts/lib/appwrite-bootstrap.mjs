import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Client, Databases } from 'node-appwrite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const botDir = resolve(__dirname, '../..');

dotenv.config({ path: resolve(botDir, '.env') });
dotenv.config({ path: resolve(botDir, '../.env') });

const endpoint = process.env.APPWRITE_ENDPOINT?.trim() || 'https://appwrite.vibecoding.by/v1';
const projectId = process.env.APPWRITE_PROJECT_ID?.trim() || '69af2faa003646d3574c';
const databaseId = process.env.APPWRITE_DATABASE_ID?.trim() || 'amina';
const apiKey = process.env.APPWRITE_API_KEY?.trim() || '';

if (!apiKey) {
  throw new Error('APPWRITE_API_KEY is required to manage Appwrite schema');
}

const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

export const bootstrapConfig = {
  endpoint,
  projectId,
  databaseId,
};

export const databases = new Databases(client);

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export async function ensureDatabaseExists() {
  await databases.get(databaseId);
}

export async function ensureCollection(collectionId, name) {
  try {
    await databases.getCollection(databaseId, collectionId);
    console.log(`  ~ ${collectionId} already exists`);
    return false;
  } catch {
    await databases.createCollection(databaseId, collectionId, name, []);
    console.log(`  + created ${collectionId}`);
    return true;
  }
}

export async function ensureAttribute(collectionId, definition) {
  const {
    type,
    key,
    size,
    required = false,
    default: defaultValue,
    array = false,
    min,
    max,
    elements,
  } = definition;

  try {
    switch (type) {
      case 'string':
      case 'text':
        await databases.createStringAttribute(
          databaseId,
          collectionId,
          key,
          size ?? (type === 'text' ? 1_000_000 : 255),
          required,
          defaultValue,
          array,
        );
        break;
      case 'integer':
        await databases.createIntegerAttribute(databaseId, collectionId, key, required, min, max, defaultValue, array);
        break;
      case 'float':
        await databases.createFloatAttribute(databaseId, collectionId, key, required, min, max, defaultValue, array);
        break;
      case 'boolean':
        await databases.createBooleanAttribute(databaseId, collectionId, key, required, defaultValue, array);
        break;
      case 'datetime':
        await databases.createDatetimeAttribute(databaseId, collectionId, key, required, defaultValue, array);
        break;
      case 'enum':
        await databases.createEnumAttribute(databaseId, collectionId, key, elements, required, defaultValue, array);
        break;
      default:
        throw new Error(`Unsupported attribute type: ${type}`);
    }
    console.log(`    + ${key} (${type})`);
  } catch (error) {
    if (error?.code === 409) {
      console.log(`    ~ ${key} already exists`);
      return;
    }
    throw error;
  }
}

export async function ensureIndex(collectionId, definition) {
  const { key, type, attributes, orders } = definition;
  try {
    await databases.createIndex(databaseId, collectionId, key, type, attributes, orders);
    console.log(`    + index ${key}`);
  } catch (error) {
    if (error?.code === 409) {
      console.log(`    ~ index ${key} already exists`);
      return;
    }
    throw error;
  }
}

export async function runSchemaSections(sections) {
  console.log('Appwrite bootstrap target:');
  console.log(`  endpoint: ${bootstrapConfig.endpoint}`);
  console.log(`  project:  ${bootstrapConfig.projectId}`);
  console.log(`  database: ${bootstrapConfig.databaseId}`);

  await ensureDatabaseExists();

  for (const section of sections) {
    console.log(`\n[${section.id}] ${section.name}`);
    await ensureCollection(section.id, section.name);

    for (const attribute of section.attributes ?? []) {
      await ensureAttribute(section.id, attribute);
    }

    if (section.waitMs) {
      await sleep(section.waitMs);
    }

    for (const index of section.indexes ?? []) {
      await ensureIndex(section.id, index);
    }
  }
}
