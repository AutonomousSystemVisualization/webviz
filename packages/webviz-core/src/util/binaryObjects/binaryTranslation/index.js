// @flow
//
//  Copyright (c) 2020-present, Cruise LLC
//
//  This source code is licensed under the Apache License, Version 2.0,
//  found in the LICENSE file in the root directory of this source tree.
//  You may not use this file except in compliance with the License.

import { sumBy, maxBy } from "lodash";

import ModuleFactory from "./bin/translator";
import ModuleWasm from "./bin/translator.wasm";
import type { Message } from "webviz-core/src/players/types";
import type { RosDatatype, RosDatatypes } from "webviz-core/src/types/RosDatatypes";

// TODO: move this to a utils file?
function isNodeModule() {
  // $FlowFixMe - cannot resolve browser property for process.
  return process === "undefined" || !process.browser;
}

// TODO: move this to a utils file?
async function getModuleFactory(): any {
  // When running outside a browser (i.e. tests), we can let Emscripten to
  // resolve the WASM file automatically. That does fail when running in the browser because
  // of Webpack, so we need to indicate the Wasm location manually
  if (isNodeModule()) {
    return ModuleFactory();
  }
  return ModuleFactory({
    locateFile: () => {
      // get the path to the wasm file
      // Webpack puts this file in the `dist` directory
      return ModuleWasm;
    },
  });
}

export interface BinaryDefinition {
  getSize(): number;
}

export type BinaryObjects = $ReadOnly<{|
  dataType: string,
  offsets: $ReadOnlyArray<number>,
  buffer: ArrayBuffer,
  bigString: string,
|}>;

export const DefinitionCommand = {
  READ_FIXED_SIZE_DATA: 0,
  READ_STRING: 1,
  READ_DYNAMIC_SIZE_DATA: 2,
  CONSTANT_ARRAY: 3,
  DYNAMIC_ARRAY: 4,
};

export default class BinaryMessageWriter {
  _bridgeInstance = null;
  _definitionRegistry: any = null;

  async initialize() {
    this._bridgeInstance = await getModuleFactory();
    this._definitionRegistry = new this._bridgeInstance.DefinitionRegistry();
  }

  _getBridge(): any {
    if (!this._bridgeInstance) {
      throw new Error("Wasm bridge not initialized");
    }
    return this._bridgeInstance;
  }

  _getDefinitions(): any {
    if (!this._definitionRegistry) {
      throw new Error("Definition registry not initialized");
    }
    return this._definitionRegistry;
  }

  // Creates a definition and adds it to the registry
  // Does not validate the definition. It must be done later.
  _createDefinition(name: string, dataType: RosDatatype): BinaryDefinition {
    const definition = this._getDefinitions().create(name);
    for (const field of dataType.fields) {
      if (field.isConstant) {
        // ignore constant fields since they have no values in the message's data.
        continue;
      }
      if (!definition.addField(field.type, field.name, field.isArray, field.arrayLength ?? -1)) {
        throw new Error(`Could not add field with type "${field.type}"`);
      }
    }
    return definition;
  }

  // Register a single definition. Performs validation before returning
  registerDefinition(name: string, dataType: RosDatatype): BinaryDefinition {
    const definition = this._createDefinition(name, dataType);
    if (!this._getDefinitions().finalize()) {
      throw new Error(`Invalid definition "${name}"`);
    }
    return definition;
  }

  registerDefinitions(dataTypes: RosDatatypes): BinaryDefinition[] {
    const definitions = Object.keys(dataTypes).map((type) => {
      return this._createDefinition(type, dataTypes[type]);
    });
    if (!this._getDefinitions().finalize()) {
      throw new Error(`Failed to validate definitions`);
    }
    return definitions;
  }

  getDefinitionCommands(definitionName: string): number[] {
    const definition = this._getDefinitions().get(definitionName);
    if (!definition) {
      throw new Error(`No definition found with type "${definitionName}"`);
    }

    const ret = [];
    const cmds = definition.getCommands();
    for (let i = 0; i < cmds.size(); i++) {
      ret.push(cmds.get(i));
    }
    return ret;
  }

  rewriteMessages(definitionName: string, messages: Message[]): BinaryObjects {
    const bridge = this._getBridge();

    const definition = this._getDefinitions().get(definitionName);
    if (!definition) {
      throw new Error(`No definition found with type "${definitionName}"`);
    }

    const writer = new bridge.MessageWriter();

    // Get memory requirements for all messages
    // See MessageWriter::reserve() for more information
    const totalBytes = sumBy(messages, (m) => m.message.byteLength);
    const maxMessageBytes = maxBy(messages, (m) => m.message.byteLength)?.message.byteLength;
    writer.reserve(definition, messages.length, totalBytes);

    // Allocate a buffer to use to send data to C++ code that is big
    // enough to handle the maximum number of bytes for a single message
    // eslint-disable-next-line no-underscore-dangle
    const inDataPtr = bridge._malloc(maxMessageBytes);
    if (!inDataPtr) {
      throw new Error(`Could not allocate memory for data buffer with size "${maxMessageBytes}"`);
    }

    // Translate messages
    const offsets = messages.map((m) => {
      const { topic } = m;
      const data: ArrayBuffer = m.message;
      const dataLength = data.byteLength;

      const view = new Uint8Array(data);
      bridge.HEAPU8.set(view, inDataPtr); // requires typed array

      const offset = writer.write(definition, inDataPtr, dataLength);
      if (offset < 0) {
        throw new Error(`Could not write message from "${topic}" with undefined type "${definitionName}"`);
      }

      return offset;
    });

    // eslint-disable-next-line no-underscore-dangle
    bridge._free(inDataPtr);

    // Copy result data int new arrays so we can access them
    // after the writer has been deleted (a few lines below).
    const buffer = new Uint8Array(writer.getBuffer()).buffer;
    const bigString = new TextDecoder("utf-8").decode(writer.getBigString());

    writer.delete();

    return {
      dataType: definitionName,
      offsets,
      buffer,
      bigString,
    };
  }
}
