/**
 * Webpack config for production electron main process
 */

import path from 'path';
import webpack from 'webpack';
import { merge } from 'webpack-merge';
// Load .env.local at build time so secrets are never hardcoded in source.
// Shell env vars (e.g. CI secrets) take priority over .env.local.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.local') });
import TerserPlugin from 'terser-webpack-plugin';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import baseConfig from './webpack.config.base';
import webpackPaths from './webpack.paths';
import checkNodeEnv from '../scripts/check-node-env';
import deleteSourceMaps from '../scripts/delete-source-maps';

checkNodeEnv('production');
deleteSourceMaps();

const configuration: webpack.Configuration = {
  devtool: 'source-map',

  mode: 'production',

  target: 'electron-main',

  entry: {
    main: path.join(webpackPaths.srcMainPath, 'main.ts'),
    preload: path.join(webpackPaths.srcMainPath, 'preload.ts'),
    // Main-DB worker_thread entry (node:sqlite). Bundled standalone so
    // db.ts can `new Worker(__dirname + '/db-worker.js')` in packaged builds;
    // dev runs the TS source directly via tsx.
    'db-worker': path.join(webpackPaths.srcMainPath, 'main-db', 'worker.js'),
  },

  output: {
    path: webpackPaths.distMainPath,
    filename: '[name].js',
    library: {
      type: 'umd',
    },
  },

  optimization: {
    minimizer: [
      new TerserPlugin({
        parallel: true,
      }),
    ],
  },

  plugins: [
    new BundleAnalyzerPlugin({
      analyzerMode: process.env.ANALYZE === 'true' ? 'server' : 'disabled',
      analyzerPort: 8888,
    }),

    /**
     * Create global constants which can be configured at compile time.
     *
     * Useful for allowing different behaviour between development builds and
     * release builds
     *
     * NODE_ENV should be production so that modules do not perform certain
     * development checks
     */
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
      DEBUG_PROD: false,
      START_MINIMIZED: false,
      // Sentry — empty string disables error reporting
      SENTRY_DSN: '',
      // ConvertAPI — PDF→DOCX export; empty disables the feature
      CONVERT_API_TOKEN: '',
    }),

    new webpack.DefinePlugin({
      'process.type': '"browser"',
    }),

    // Ship the utilityProcess worker scripts (embedding-worker, local-llm-worker,
    // …) VERBATIM into dist/main/ai/workers. They are forked by
    // `utilityProcess.fork(workerPath())` at runtime — not imported — so unlike
    // db-worker they are NOT a webpack entry and would otherwise be absent from
    // the package, making the fork fail with ERR_MODULE_NOT_FOUND (the embedder
    // then "crashes" on every call). Copying verbatim preserves the hand-authored
    // `new Function('return import("node-llama-cpp")')` ESM-load trick exactly.
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.join(webpackPaths.srcMainPath, 'ai', 'workers'),
          to: path.join(webpackPaths.distMainPath, 'ai', 'workers'),
          // Mark as already-minimized so TerserPlugin SKIPS these files. They
          // are CommonJS modules with valid top-level `return` guards (e.g.
          // image-to-text-worker.js) that Terser would reject as "'return'
          // outside of function" if it tried to minify the copied asset. We want
          // them verbatim anyway — they're forked as-is at runtime.
          info: { minimized: true },
        },
      ],
    }),
  ],

  /**
   * Disables webpack processing of __dirname and __filename.
   * If you run the bundle in node.js it falls back to these values of node.js.
   * https://github.com/webpack/webpack/issues/2010
   */
  node: {
    __dirname: false,
    __filename: false,
  },
};

export default merge(baseConfig, configuration);