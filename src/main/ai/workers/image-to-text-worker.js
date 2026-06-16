const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { getImageToTextPipelineForWorker } = require('./worker-transformers');

async function imageToText(imagePath) {
  try {
    const model = await getImageToTextPipelineForWorker();

    if (!fs.existsSync(imagePath)) {
      console.error(`Image file does not exist: ${imagePath}`);
      return 'Image file not found';
    }

    const result = await model(imagePath);
    return result[0]?.generated_text ?? '';
  } catch (err) {
    console.error('Unable to perform image-to-text conversion');
    console.error(err);
    return '';
  }
}

async function processImage(imagePath) {
  const imageText = await imageToText(imagePath);
  parentPort.postMessage(imageText);
}

if (workerData.imagePath) {
  processImage(workerData.imagePath);
} else {
  return '';
}
