import { editImage } from './bot/src/ai/image-gen.js';
import fs from 'fs';

async function test() {
  try {
    console.log('Testing image edit...');
    // Create a tiny 1x1 black pixel PNG
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const result = await editImage(base64, 'image/png', 'make it red');
    console.log('Success!', result.model, result.generationTimeMs + 'ms');
    fs.writeFileSync('test-edited.png', result.image);
  } catch (error) {
    console.error('Failed:', error);
  }
}

test();
