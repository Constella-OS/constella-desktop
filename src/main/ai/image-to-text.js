import { app } from 'electron';
import * as path from 'path';
import { getLocalFilePath } from '../utils/storage/storage';
const fs = require('fs');

const { createEmbedding } = require('./create-embedding');
const { getImageToTextPipeline } = require('./transformers');

/**
 * Converts image to text using the image-to-text pipeline
 * Note: adds around ~200 to 250MB of extra space
 * @param {*} imagePath
 * @returns
 */
const imageToText = async (imagePath) => {
  try {
    const model = await getImageToTextPipeline();

    if (!fs.existsSync(imagePath)) {
      console.error(`Image file does not exist: ${imagePath}`);
      return 'Image file not found';
    }

    const result = await model(imagePath);

    return result[0]?.generated_text ?? '';
  } catch (err) {
    console.error('Unable to perform image-to-text conversion');
    console.error(err);
    return err;
  }
};

/**
 * This will create the full path to where it's stored and then
 * will call the imageToText function to get the text and then
 * will call the createEmbedding function to get the embedding
 * @param {} imagePath - relative to /constella-assets
 * @returns
 */
export const createImageEmbedding = async (imagePath) => {
  try {
    const imageText = await imageToText(getLocalFilePath(imagePath, false));
    const embedding = await createEmbedding(imageText);
    return {
      imageText,
      embedding,
    };
  } catch (error) {
    console.error('Error creating image embedding:', error);
    return null;
  }
};

export const imageToTextWithFileProcessing = async (imagePath) => {
  try {
    const imageText = await imageToText(getLocalFilePath(imagePath, false));
    return imageText;
  } catch (error) {
    console.error('Error creating image embedding:', error);
    return null;
  }
};
