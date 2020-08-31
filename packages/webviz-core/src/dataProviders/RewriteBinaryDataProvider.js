// @flow
//
//  Copyright (c) 2020-present, Cruise LLC
//
//  This source code is licensed under the Apache License, Version 2.0,
//  found in the LICENSE file in the root directory of this source tree.
//  You may not use this file except in compliance with the License.
import { groupBy } from "lodash";
import { type Time, TimeUtil } from "rosbag";

import BinaryMessageWriter from "../util/binaryObjects/binaryTranslation";
import type {
  DataProviderDescriptor,
  DataProvider,
  GetDataProvider,
  ExtensionPoint,
  GetMessagesResult,
  GetMessagesTopics,
  InitializationResult,
} from "webviz-core/src/dataProviders/types";
import type { RosDatatypes } from "webviz-core/src/types/RosDatatypes";
import { getObjects } from "webviz-core/src/util/binaryObjects";
import naturalSort from "webviz-core/src/util/naturalSort";
import sendNotification from "webviz-core/src/util/sendNotification";

export default class RewriteBinaryDataProvider implements DataProvider {
  _provider: DataProvider;
  _extensionPoint: ExtensionPoint;
  _useBinaryObjects: boolean;
  _writer: BinaryMessageWriter;
  _datatypeByTopic: { [topic: string]: string };
  _datatypes: RosDatatypes;

  constructor(
    { useBinaryObjects }: {| useBinaryObjects: boolean |},
    children: DataProviderDescriptor[],
    getDataProvider: GetDataProvider
  ) {
    this._provider = getDataProvider(children[0]);
    this._useBinaryObjects = useBinaryObjects;
  }

  async initialize(extensionPoint: ExtensionPoint): Promise<InitializationResult> {
    this._extensionPoint = extensionPoint;
    const result = await this._provider.initialize({ ...extensionPoint, progressCallback: () => {} });

    if (this._useBinaryObjects) {
      this._writer = new BinaryMessageWriter();
      await this._writer.initialize();

      const { datatypes, topics } = result;
      try {
        this._writer.registerDefinitions(datatypes);
        this._datatypes = datatypes;
        this._datatypeByTopic = {};
        topics.forEach((topic) => (this._datatypeByTopic[topic.name] = topic.datatype));
      } catch (err) {
        sendNotification("Failed to register type definitions", err ? err.message : "<unknown error>", "app", "error");
      }
    }

    return result;
  }

  async getMessages(start: Time, end: Time, subscriptions: GetMessagesTopics): Promise<GetMessagesResult> {
    const { rosBinaryMessages } = await this._provider.getMessages(start, end, {
      rosBinaryMessages: subscriptions.bobjects,
    });

    if (!this._useBinaryObjects) {
      return {
        // $FlowFixMe: Lie about the type when not rewriting. Helpful for tests.
        bobjects: rosBinaryMessages,
        rosBinaryMessages: undefined,
        parsedMessages: undefined,
      };
    }

    const bobjects = [];

    try {
      if (rosBinaryMessages) {
        const messagesByTopic = groupBy(rosBinaryMessages, "topic");
        Object.keys(messagesByTopic).forEach((topic) => {
          const definitionName = this._datatypeByTopic[topic];
          const messages = messagesByTopic[topic];
          const binary = this._writer.rewriteMessages(definitionName, messages);
          const binaryObjects = getObjects(
            this._datatypes,
            this._datatypeByTopic[topic],
            binary.buffer,
            binary.bigString,
            binary.offsets
          );
          bobjects.push(
            ...binaryObjects.map((b, i) => ({
              message: b,
              topic,
              receiveTime: messages[i].receiveTime,
            }))
          );
        });
      }
    } catch (err) {
      sendNotification("Failed to write binary objects", err ? err.message : "<unknown error>", "app", "error");
    }

    return {
      bobjects: bobjects.sort(
        (a, b) => TimeUtil.compare(a.receiveTime, b.receiveTime) || naturalSort()(a.topic, b.topic)
      ),
      rosBinaryMessages: undefined,
      parsedMessages: undefined,
    };
  }

  close(): Promise<void> {
    return this._provider.close();
  }
}
