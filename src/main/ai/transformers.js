const TransformersApi = Function('return import("@xenova/transformers")')();

let imageToTextPipeline = null;

// NOTE: text embedding no longer runs through transformers.js / MiniLM. All text
// embeds on the single node-llama-cpp runtime (EmbeddingGemma) via
// ./embedding/embedding-service. transformers.js is kept only for image captioning.

export const getImageToTextPipeline = async (progress_callback = null) => {
  try {
    if (!imageToTextPipeline) {
      const { pipeline } = await TransformersApi;
      imageToTextPipeline = await pipeline(
        'image-to-text',
        'Xenova/vit-gpt2-image-captioning',
        {
          progress_callback,
        },
      );
    }
    return imageToTextPipeline;
  } catch (error) {
    console.error('Error initializing image-to-text pipeline:', error);
  }
};
