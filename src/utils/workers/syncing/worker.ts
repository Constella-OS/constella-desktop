import { getCurrentUserEmailSync } from './../../firebase/firebase-auth';
import {
  addToAstroDB,
  getSingleAstroDBNode,
  removeMultipleFromAstroDB,
  syncVectorsFromCloud,
} from '../../../db/astro-wrapper';
import {
  MiscDataTypes,
  rxdbBulkUpsertMiscData,
  rxdbDeleteMiscByIds,
} from '../../../db/misc-localrxdb';
import {
  rxdbDeleteNotesByIds,
  rxdbBulkUpdateNotes,
  rxdbFindNotesByUuids,
} from '../../../db/notes-localrxdb';
import {
  rxdbBulkUpdateTagObjects,
  rxdbDeleteTagsByIds,
} from '../../../db/tags-localrxdb';
import { BACKEND_URL } from '../../../main/constants';
import Tag from '../../../models/Tag';
import { getCurrentUserId } from '../../firebase/firebase-auth';
import { getFilePathForNote } from '../../note-logic';
import {
  checkIfFileExists,
  createTitleForDocumentNote,
  createTitleForImageNote,
  isFileDataNote,
  isImageNote,
} from '../../storage/helpers';
import { NewAstroNode, SyncOptions, SyncResults } from './../../types';
import { saveImagesFromNoteBody } from '../../cloud-sync/note-bodies-syncing';
import { processImageFileData } from '../../storage/image';
import { processDocFileData } from '../../storage/file';
import { embedText } from '../../misc/embeddings';
import { AstroNodeType } from '../../../../astrovault/astronode';
import { processNoteBodyForEmbeddings } from '../../notes/note-bodies';
import { convertTodosToTitle, parseTodosFromFileText } from '../../notes/todos';
import { processIncomingNoteWithEmbeddings } from '../../cloud-sync/syncing-utils';

/**
 * Based on the deleted results, deletes the items in the database
 * @param deleted_results
 * @param noteIdsToRemove
 * @param miscIdsToRemove
 * @param miscObjectsToRemove
 * @param tagIdsToRemove
 */
async function handleDeletions(
  deleted_results: any[],
  noteIdsToRemove: string[],
  miscIdsToRemove: string[],
  miscObjectsToRemove: Record<string, any>[],
  tagIdsToRemove: string[],
) {
  try {
    // First delete all the deleted results
    for (const deletedResult of deleted_results) {
      if (deletedResult.recordType === 'note') {
        try {
          noteIdsToRemove.push(deletedResult.uniqueid);
        } catch (error) {
          console.error('Error deleting note: ', error);
        }
      } else if (
        deletedResult.recordType === MiscDataTypes.EDGE_LABEL ||
        deletedResult.recordType === MiscDataTypes.SAVED_VIEW
      ) {
        try {
          miscIdsToRemove.push(deletedResult.uniqueid);
          miscObjectsToRemove.push({
            type: deletedResult.recordType,
            uniqueid: deletedResult.uniqueid,
            lastModified: deletedResult.lastModified,
          });
        } catch (error) {
          console.error('Error deleting misc data: ', error);
        }
      } else {
        try {
          tagIdsToRemove.push(deletedResult.uniqueid);
        } catch (error) {
          console.error('Error deleting tag: ', error);
        }
      }
    }

    // Bulk delete operations
    try {
      if (noteIdsToRemove.length > 0) {
        await rxdbDeleteNotesByIds(noteIdsToRemove, false);
      }
      if (tagIdsToRemove.length > 0) {
        await rxdbDeleteTagsByIds(tagIdsToRemove);
      }
      if (miscIdsToRemove.length > 0) {
        await rxdbDeleteMiscByIds(miscIdsToRemove);
      }
      if (noteIdsToRemove.length > 0) {
        await removeMultipleFromAstroDB(noteIdsToRemove);
      }
    } catch (error) {
      console.error('Error deleting notes: ', error);
    }
  } catch (err) {
    console.error('Error in handleDeletions:', err);
  }
}

async function syncByLastModified(
  lastSyncDateTimeUTC: Date,
  currentTags: Record<string, Tag>,
  fullSync: boolean = false,
  progressCallback?: (progress: number) => void,
): Promise<SyncResults> {
  try {
    const deviceId = await window.electron.ipcRenderer.invoke(
      'get-device-id',
      {},
    );
    const userID = await getCurrentUserId();
    const email = getCurrentUserEmailSync();

    // if ignoring device id, doing a complete re-sync so set last sync date to the beginning of time
    if (fullSync) {
      lastSyncDateTimeUTC = new Date(0);
    }

    let offset = 0;
    let hasMoreResults = true;
    let isFirstBatch = true;
    const BATCH_SIZE = 100;
    const MAX_LOOPS = 3000; // prevent infinite loops
    let currLoop = 0;

    // Objects to remove
    const noteIdsToRemove: string[] = [];
    const miscIdsToRemove: string[] = [];
    const miscObjectsToRemove: Record<string, any>[] = []; // using objects to track type of misc item as well
    const tagIdsToRemove: string[] = [];

    // Objects to upsert
    const allNotesToUpsert: Record<string, any>[] = [];
    const allTagsToUpsert: Record<string, any>[] = [];
    const allMiscItemsToUpsert: Record<string, any>[] = [];

    // All accumulated vectors to update or add
    const allVectorsToSync: { uniqueid: string; vector: number[] }[] = [];

    let progress = 0;

    while (hasMoreResults && currLoop < MAX_LOOPS) {
      try {
        const response = await self.fetch(
          `${BACKEND_URL}constella_db/sync_by_last_modified`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'device-id': deviceId,
            },
            body: JSON.stringify({
              tenant_name: userID,
              user_email: email,
              last_sync_datetime_utc: lastSyncDateTimeUTC.toISOString(),
              use_background_task: false,
              use_batching: true,
              limit: BATCH_SIZE,
              offset: offset,
            }),
          },
        );

        progress += 1;
        progressCallback && progressCallback(Math.min(progress, 90));

        const responseData = await response.json();

        const { results = [], deleted_results = [] } = responseData;

        console.log('results: ', results);

        // Update the looping operations
        offset += results.length;

        if (isFirstBatch) {
          await handleDeletions(
            deleted_results,
            noteIdsToRemove,
            miscIdsToRemove,
            miscObjectsToRemove,
            tagIdsToRemove,
          );
          isFirstBatch = false;
        }

        // If no results, then we're done
        if (results.length === 0) {
          hasMoreResults = false;
          break;
        }

        currLoop++;

        const notesToUpsert: Record<string, any>[] = [];
        let tagsToUpsert: Record<string, any>[] = [];
        const miscItemsToUpsert: Record<string, any>[] = [];
        const vectorsToSync: NewAstroNode[] = [];

        for (const item of results) {
          try {
            if (item['vector'] && item['vector']['default']) {
              item['vector'] = item['vector']['default'];
            }

            // Skip items of same device id
            if (item['lastUpdateDeviceId'] === deviceId && !fullSync) {
              console.log('Skipping item of same device id');
              continue;
            }

            if (item.recordType === 'note') {
              const {
                processedNote,
                tagsToUpsert: newTags,
                vectorsToSync: noteVectors,
                needsFileProcessing,
              } = await processIncomingNoteWithEmbeddings(
                item,
                currentTags,
                userID,
                fullSync,
                true, // try network requests for cloud sync
              );

              // Add tags to upsert list
              tagsToUpsert.push(...newTags);

              // Add vectors to sync list
              vectorsToSync.push(...noteVectors);

              // Add to notes to upsert
              notesToUpsert.push(processedNote);
            } else if (item.recordType === 'tag') {
              tagsToUpsert.push(item);
            } else if (item.recordType === 'misc') {
              if (item.type === MiscDataTypes.SAVED_VIEW) {
                try {
                  await addToAstroDB(
                    item.uniqueid,
                    await embedText(item.miscData),
                    false,
                    AstroNodeType.VIEW,
                  );
                } catch (error) {
                  console.error('Error embedding SAVED VIEW: ', error);
                }
              }
              miscItemsToUpsert.push(item);
            } else if (item.recordType === 'noteBody') {
              // If it's a journal type
            } else {
              console.log('ITEM TYPE: ', item.recordType);
            }
          } catch (error) {
            console.error(`Error processing item ${item.id}:`, error);
          }
        }

        // Process tags to ensure they only have the required properties & handle duplicates
        const uniqueTagsMap = new Map();

        // Iterate through tags in reverse to keep the last occurrence of each uniqueid
        for (let i = tagsToUpsert.length - 1; i >= 0; i--) {
          const tag = tagsToUpsert[i];
          if (tag.uniqueid && !uniqueTagsMap.has(tag.uniqueid)) {
            uniqueTagsMap.set(tag.uniqueid, {
              uniqueid: tag.uniqueid,
              name: tag.name || '',
              color: tag.color || '',
            });
          }
        }

        // Convert map values back to array
        tagsToUpsert = Array.from(uniqueTagsMap.values());

        // Filter out notes that are already up-to-date from the websocket
        const noteIdsToUpsert = notesToUpsert.map((n) => n.uniqueid);
        const existingNotesMap = await rxdbFindNotesByUuids(noteIdsToUpsert);

        const trulyNewNotesToUpsert = notesToUpsert.filter((incomingNote) => {
          const existingDoc = existingNotesMap.get(incomingNote.uniqueid);
          if (!existingDoc) {
            return true; // Note doesn't exist locally, so it's new
          }

          // The 'lastModified' on incomingNote was set from the server's 'last_updated_utc'
          // earlier in the loop. We compare it against the local 'lastModified'.
          const remoteLastModified = incomingNote.lastModified;
          if (!remoteLastModified) {
            return true; // No timestamp from server, update to be safe
          }

          const localLastModified = existingDoc._data.lastModified;

          // Only update if the remote version is strictly newer.
          // This comparison is not perfect due to potential client-side clock skew
          // from WebSocket updates, but it prioritizes preventing overwrites of
          // local unsynced changes.
          return remoteLastModified > localLastModified;
        });

        // Bulk update RXDB operations
        await rxdbBulkUpdateNotes(trulyNewNotesToUpsert);
        await rxdbBulkUpdateTagObjects(tagsToUpsert);
        await rxdbBulkUpsertMiscData(miscItemsToUpsert);

        allVectorsToSync.push(...vectorsToSync);

        // ! IMPORTANT: we limit all notes to upsert to 100 to avoid memory issues
        if (allNotesToUpsert.length < 100) {
          allNotesToUpsert.push(...trulyNewNotesToUpsert);
        }
        allTagsToUpsert.push(...tagsToUpsert);
        allMiscItemsToUpsert.push(...miscItemsToUpsert);

        progress += 1;
        progressCallback && progressCallback(Math.min(progress, 90));
      } catch (error) {
        console.error(
          'Error in while loop top level, syncByLastModified:',
          error,
        );
      }
    }

    // Run this in a worker to sync the text vectors and it'll save index at end
    await syncVectorsFromCloud(allVectorsToSync).catch((error) => {
      console.error('Error in syncVectorsFromCloud: ', error);
    });

    return {
      status: 'Sync' as SyncOptions,
      miscIdsToRemove,
      miscObjectsToRemove,
      miscItemsToUpsert: allMiscItemsToUpsert,
      noteIdsToRemove,
      notesToUpsert: allNotesToUpsert,
      tagIdsToRemove,
      tagsToUpsert: allTagsToUpsert,
    };
  } catch (error) {
    console.error('Error in syncByLastModified:', error);
    throw error;
  }
}

export const syncLocalWithCloud = (
  lastSyncDateTimeUTC: Date,
  currentTags: Record<string, Tag>,
  fullSync: boolean = false, // if true, will sync even if the device id is the same (i.e. if reset locally and then reconnecting to cloud)
  progressCallback?: (progress: number) => void,
): Promise<SyncResults> => {
  // TODO: re-enable syncing when ready
  console.log('[Sync] Syncing disabled temporarily');
  return Promise.resolve({
    status: 'Sync' as SyncOptions,
    miscIdsToRemove: [],
    miscObjectsToRemove: [],
    miscItemsToUpsert: [],
    noteIdsToRemove: [],
    notesToUpsert: [],
    tagIdsToRemove: [],
    tagsToUpsert: [],
  });
  return syncByLastModified(
    lastSyncDateTimeUTC,
    currentTags,
    fullSync,
    progressCallback,
  ).then((results) => {
    return results;
  });
};

/**
 * Combines two sync results, used for syncing integrations
 * after initial sync. Returns the status of the second result.
 * @param syncResultsInitial
 * @param syncResultsSecond
 * @returns
 */
export const combineSyncResults = (
  syncResultsInitial: SyncResults,
  syncResultsSecond: SyncResults,
) => {
  // If either exists and the other doesn't, then return the one that does
  if (
    syncResultsInitial &&
    Object.keys(syncResultsInitial).length > 0 &&
    (!syncResultsSecond || Object.keys(syncResultsSecond).length === 0)
  ) {
    return syncResultsInitial;
  } else if (
    (!syncResultsInitial || Object.keys(syncResultsInitial).length === 0) &&
    syncResultsSecond &&
    Object.keys(syncResultsSecond).length > 0
  ) {
    return syncResultsSecond;
  }

  return {
    status: syncResultsSecond?.status ?? syncResultsInitial?.status ?? 'Sync',
    miscIdsToRemove: [
      ...(syncResultsInitial?.miscIdsToRemove ?? []),
      ...(syncResultsSecond?.miscIdsToRemove ?? []),
    ],
    miscObjectsToRemove: [
      ...(syncResultsInitial?.miscObjectsToRemove ?? []),
      ...(syncResultsSecond?.miscObjectsToRemove ?? []),
    ],
    miscItemsToUpsert: [
      ...(syncResultsInitial?.miscItemsToUpsert ?? []),
      ...(syncResultsSecond?.miscItemsToUpsert ?? []),
    ],
    noteIdsToRemove: [
      ...(syncResultsInitial?.noteIdsToRemove ?? []),
      ...(syncResultsSecond?.noteIdsToRemove ?? []),
    ],
    notesToUpsert: [
      ...(syncResultsInitial?.notesToUpsert ?? []),
      ...(syncResultsSecond?.notesToUpsert ?? []),
    ],
    tagIdsToRemove: [
      ...(syncResultsInitial?.tagIdsToRemove ?? []),
      ...(syncResultsSecond?.tagIdsToRemove ?? []),
    ],
    tagsToUpsert: [
      ...(syncResultsInitial?.tagsToUpsert ?? []),
      ...(syncResultsSecond?.tagsToUpsert ?? []),
    ],
  };
};
