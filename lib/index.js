/* --------------------
 * zip-random-access module
 * Entry point
 * ------------------*/

'use strict';

// Modules
const {stat} = require('fs/promises'),
	{PassThrough} = require('stream'),
	{ZipFile} = require('yazl'),
	{isString, isPositiveInteger, isPositiveIntegerOrZero, isArray, isObject} = require('is-it-type'),
	assert = require('simple-invariant');

// Exports

// Fake stream which does nothing
const fakeStream = {
	pipe() {
		return fakeStream;
	}
};

class Zip {
	/**
	 * `Zip` class constructor.
	 * @param {Array<Object>} files - Array of file objects
	 *   of form `{path: string, filename: string, size: [number]}`
	 */
	constructor(files) {
		this.size = null;

		this._chunks = [];
		const zip = new ZipFile();
		this._zip = zip;
		zip.outputStream = {
			write: (buff) => {
				this._chunks.push({buff, file: null, offset: zip.outputStreamCursor});
			}
		};

		this._outputs = new Set();
		this._currentFileIndex = null;
		this._nextFileIndex = 0;
		this._currentSize = 0;

		// Validate and conform `files`.
		// If size is provided for all files, no initialization is required.
		assert(isArray(files), 'files must be an array');

		let allFileSizesKnown = true;
		this._files = files.map((file) => {
			assert(isObject(file), 'files must be objects or strings');
			let {path, filename, size} = file; // eslint-disable-line prefer-const
			assert(isString(path), 'file objects must have a string `path` property');
			assert(isString(filename), 'file objects must have a string `filename` property');
			if (size == null) {
				size = null; // Convert `undefined` to `null`
				allFileSizesKnown = false;
			} else {
				assert(
					isPositiveIntegerOrZero(size), "file objects' `.size` property must be an integer or null"
				);
			}
			return {path, filename, size, crc32Watcher: null, compressedSizeCounter: null};
		});

		// TODO Get filenames from paths if not provided

		// Get size of ZIP file
		if (allFileSizesKnown) this._calculateZipSize();
	}

	/**
	 * Get size of all files.
	 * Only needs to be called if file sizes not provided by user.
	 * @returns {undefined}
	 */
	async init() {
		if (this.size) return;

		for (const file of this.files) {
			if (file.size === null) file.size = (await stat(file.path)).size;
		}

		this._calculateZipSize();
	}

	/**
	 * Calculate size of output ZIP file.
	 * @returns {undefined}
	 */
	_calculateZipSize() {
		const zip = new ZipFile();
		zip.outputStream = {write() {}};

		for (const file of this._files) {
			zip.addReadStream(fakeStream, file.filename, {compress: false, size: file.size});
		}

		zip.end((size) => { this.size = size; });
		assert(this.size, 'Failed to calculate size');
	}

	_buildZip() {
		const zip = new ZipFile(),
			chunks = this._chunks;
		let file;
		const fakeOutputStream = {
			write(buff) {
				if (buff.length === 0) return;
				chunks.push({offset: zip.outputStreamCursor, buff, file, crc32Offset: null});
			}
		};
		zip.outputStream = fakeOutputStream;

		let numChunks = 0,
			length = 0;
		for (file of this._files) {
			let streamIndex = 0;
			const fakeStream = {
				pipe(stream) { // eslint-disable-line no-loop-func
					if (streamIndex === 1) {
						stream.byteCount = file.size;
					} else if (streamIndex === 3) {
						stream.byteCount = file.size;
						// stream.on = (_eventName, handler) => handler();
					}
					streamIndex++;

					return fakeStream;
				}
			};

			zip.addReadStream(fakeStream, file.filename, {compress: false, size: file.size});

			/*
			assert(chunks.length === numChunks + 2, 'Chunks not written');
			const localFileHeaderChunk = chunks[numChunks];
			assert(localFileHeaderChunk.offset === length, 'Local file header chunk in unexpected position');
			const fileContentChunkOffset = length + localFileHeaderChunk.buff.length;
			const dataDescriptorChunk = chunks[numChunks + 1];
			assert(
				dataDescriptorChunk.offset === fileContentChunkOffset + file.size,
				'Local file header chunk in unexpected position'
			);
			dataDescriptorChunk.crc32Offset = 4;
			chunks.push(dataDescriptorChunk);

			chunks[numChunks + 1] = {offset: fileContentChunkOffset, buff: null, file, crc32Offset: null};

			numChunks += 3;
			length = dataDescriptorChunk.offset + dataDescriptorChunk.buff.length;
			*/
		}

		zip.end((size) => { this.size = size; });
		assert(this.size, 'Size failed to be computed');
	}

	/**
	 * Get readable stream for chunk of ZIP file.
	 * @param {number} offset - Offset from start of file
	 * @param {number} length - Length of chunk
	 * @returns {Object} - Readable stream for chunk of ZIP file
	 */
	getStream(offset, length) {
		assert(this.size, 'Must call `zip.init()` if file sizes not provided for all files');

		assert(isPositiveIntegerOrZero(offset), '`offset` must be a positive integer');
		assert(isPositiveInteger(length), '`length` must be a positive integer greater than 0');
		assert(offset + length <= this.size, 'End of chunk is beyond end of file');

		// Create output stream
		const outputStream = new PassThrough();
		const output = {stream: outputStream, offset, length, pos: offset};
		this._outputs.add(output);

		if (offset < this._currentSize) {
			// Output can start streaming now
			this._startOutput(output);
		} else if (this._currentFileIndex === null) {
			this._startNextFile();
		}

		return outputStream;
	}

	_startNextFile() {
		if (this._files.length === this._nextFileIndex) {
			// All files written
			// TODO
		}

		this._currentFileIndex = this._nextFileIndex;
		const file = this._files[this._currentFileIndex];

		// Capture streams from yazl
		let streamIndex = 0;
		const fakeReadStream = {
			pipe(stream) {
				if (streamIndex === 0) {
					file.crc32Watcher = stream;
				} else if (streamIndex === 1) {
					stream.byteCount = file.size;
				} else if (streamIndex === 3) {
					stream.byteCount = file.size;
					file.compressedSizeCounter = stream;
				}
				streamIndex++;

				return fakeReadStream;
			}
		};

		const numChunks = this._chunks.length;
		this._zip.addReadStream(fakeReadStream, file.filename, {compress: false, size: file.size});
		assert(this._chunks.length === numChunks + 1, 'yazl did not write local file header');
		assert(file.crc32Watcher && file.compressedSizeCounter, 'Failed to capture yazl streams');

		const localFileHeaderChunk = this._chunks[numChunks];
		this._currentSize = localFileHeaderChunk.offset + localFileHeaderChunk.buff.length + file.size;
	}

	_startOutput(output) {
		// TODO
	}
}

module.exports = Zip;
