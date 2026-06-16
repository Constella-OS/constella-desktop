const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const {
  getImageToTextPipelineForWorker,
} = require('./worker-transformers');

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
    return err;
  }
}

// The worker only does the heavy image-to-text captioning off the main thread.
// The caption is embedded by the main process on the shared node-llama-cpp
// (EmbeddingGemma) runtime so all stored vectors share one dimension/model.
async function captionImage(imagePath) {
  const imageText = await imageToText(imagePath);
  parentPort.postMessage({ imageText });
}

captionImage(workerData.imagePath);
