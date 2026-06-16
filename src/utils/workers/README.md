Note: the workers must be in '.js' due to the way the loader works and to prevent compiling issues

## Workers

`index.js` - provides the outside callable function
`worker.js` - the logic that executes when the message from index.js is received
