const serializeContentToHTML = ({ children, type }) => {
  if (type === 'paragraph' && Array.isArray(children)) {
    return children
      .map((node) => {
        if (typeof node === 'string') return node;
        if (node.type === 'text') return node.text;
        // Add more type handlers as needed
        return '';
      })
      .join('');
  }
  return '';
};

const processNotes = async ({ notes, dailyNotes }) => {
  try {
    // Process daily notes
    const parsedDailyNotes = dailyNotes.map((dailyNote) => {
      if (typeof dailyNote.content === 'string') {
        return dailyNote;
      }

      const content = JSON.parse(dailyNote.content);
      return {
        ...dailyNote,
        content: serializeContentToHTML({
          children: content,
          type: 'paragraph',
        }),
      };
    });

    // Create notes by ID mapping
    const notesbyId = notes.reduce((acc, note) => {
      acc[note.uniqueid] = note;
      return acc;
    }, {});

    return {
      success: true,
      data: {
        notes,
        notesbyId,
        dailyNotes: parsedDailyNotes,
        autoExport: true,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
};

// Handle worker messages
self.onmessage = async (event) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'process-notes':
      const result = await processNotes(payload);
      postMessage(result);
      break;
    default:
      postMessage({
        success: false,
        error: 'Unknown message type',
      });
  }
};
