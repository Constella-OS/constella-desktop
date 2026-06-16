import { ipcMain } from 'electron';
const pdf = require('pdf-parse/lib/pdf-parse');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const extractor = new WordExtractor();
import * as fs from 'fs';
import { LOCAL_FILE_PROTOCOL } from '../constants';
import { createEmbedding } from './create-embedding';
import { addFileProtocol, saveBlob } from '../utils/storage/storage';
import { WORD_FILE_TYPES } from '../../constants/notes';

const MAX_TEXT_TO_EMBED_IN_CHUNKS = 35000;
const NEXT_TEXT_TO_EMBED_IN_CHUNKS = 30000;

const processTextFromFile = async (text: string) => {
  let processedText = text
    .slice(0, MAX_TEXT_TO_EMBED_IN_CHUNKS) // sample the first 3500
    .trim()
    .replace(/  +/g, ' ') // replace double spaces
    .slice(0, NEXT_TEXT_TO_EMBED_IN_CHUNKS); // use just first X characters for finding it

  const chunks = processedText.split('\n').flatMap((chunk: string) =>
    chunk
      .replace(/\n/g, '')
      .trim()
      .split(/[.!?]+/)
      .filter(Boolean)
      .map((sentence) => sentence.trim()),
  );

  const embeddings = [];
  for (const chunk of chunks) {
    const embedding = await createEmbedding(chunk);
    embeddings.push(embedding);
  }

  return { processedText, chunks, embeddings };
};

export const setupFileEmbeddingHandlers = () => {
  /**
   * Create multiple embeddings for a file in the different ways possible
   * Also while reading the file, return the base64 data if possible so Weaviate can save it
   */
  ipcMain.handle(
    'embed-file',
    async (event, { fileData, fileType, filePath }) => {
      return new Promise(async (resolve, reject) => {
        try {
          fileData = fileData.replace(LOCAL_FILE_PROTOCOL, '');

          let newFilePath = '';

          // saves locally first on file path if cloud front url
          if (fileData.includes('cloudfront')) {
            const blob = await fetch(fileData).then((res) => res.blob());
            newFilePath = await saveBlob(blob, filePath);
            fileData = newFilePath;

            // update new file path if title needs to be updated
            newFilePath = addFileProtocol(newFilePath);
          }

          fs.readFile(fileData, (err, data) => {
            if (err) {
              console.error('Error reading file:', err);
              reject(err);
              return;
            }

            if (WORD_FILE_TYPES.includes(fileType)) {
              console.log('FILE PATH: ', fileData);

              if (fileType.includes('docx')) {
                mammoth
                  .extractRawText({ path: fileData })
                  .then(async (result: any) => {
                    var text = result.value; // The raw text

                    const { processedText, embeddings } =
                      await processTextFromFile(text);

                    resolve({
                      embeddings: embeddings,
                      base64data: data.toString('base64'), // Convert buffer to base64
                      embeddedText: processedText,
                      fileContent: text,
                      newFilePath,
                    });
                  })
                  .catch((error: any) => {
                    console.error(error);
                  });
              } else {
                const extracted = extractor.extract(fileData);

                extracted.then(async function (doc: Document) {
                  let text = '';
                  try {
                    text = doc.getBody();
                  } catch (e) {}

                  if (!text) {
                    try {
                      text += doc.getHeaders();
                    } catch (e) {}

                    try {
                      text += doc.getTextboxes();
                    } catch (e) {}
                  }

                  const { processedText, embeddings } =
                    await processTextFromFile(text);

                  resolve({
                    embeddings: embeddings,
                    base64data: data.toString('base64'), // Convert buffer to base64
                    embeddedText: processedText,
                    fileContent: text,
                    newFilePath,
                  });
                });
              }
            } else {
              // PDF parser
              pdf(data, {})
                .then(async (pdfData: any) => {
                  const text = pdfData.text;

                  const { processedText, chunks, embeddings } =
                    await processTextFromFile(text);

                  resolve({
                    embeddings: embeddings,
                    base64data: data.toString('base64'), // Convert buffer to base64
                    embeddedText: processedText,
                    fileContent: text,
                    newFilePath,
                  });
                })
                .catch((error: any) => {
                  console.error('Error processing PDF:', error);
                  reject(error);
                });
            }
          });
        } catch (error) {
          console.error('Error in embed-file:', error);
          reject(error);
        }
      });
    },
  );
};
