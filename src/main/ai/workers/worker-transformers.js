const TransformersApi = Function('return import("@xenova/transformers")')();

let imageToTextPipeline = null;

// Text embedding no longer runs in a transformers.js worker (MiniLM removed).
// This module now only provides the image-captioning pipeline for worker threads.

const getImageToTextPipelineForWorker = async () => {
  if (!imageToTextPipeline) {
    const { pipeline } = await TransformersApi;
    imageToTextPipeline = await pipeline(
      'image-to-text',
      'Xenova/vit-gpt2-image-captioning',
    );
  }
  return imageToTextPipeline;
};

module.exports = {
  getImageToTextPipelineForWorker,
};
