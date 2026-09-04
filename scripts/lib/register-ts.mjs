// Preload target for `node --import`. Installs ts-resolve.mjs as a module
// customization hook so the eval script can import electron/ sources directly.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve.mjs', pathToFileURL(import.meta.filename));
