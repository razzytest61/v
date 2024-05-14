import { VoiceChangerWorkletProcessorRequest } from "../@types/voice-changer-worklet-processor";
import {
  DefaultClientSettng,
  //DownSamplingMode,
  VOICE_CHANGER_CLIENT_EXCEPTION,
  WorkletNodeSetting,
  WorkletSetting,
} from "../const";
import { io, Socket } from "socket.io-client";
import { DefaultEventsMap } from "@socket.io/component-emitter";
import { ServerRestClient } from "./ServerRestClient";

export type VoiceChangerWorkletListener = {
  notifyVolume: (vol: number) => void;
  notifySendBufferingTime: (time: number) => void;
  notifyResponseTime: (time: number, perf?: number[]) => void;
  notifyException: (
    code: VOICE_CHANGER_CLIENT_EXCEPTION,
    message: string
  ) => void;
};

export type InternalCallback = {
  processAudio: (data: Uint8Array) => Promise<Uint8Array>;
};

export class VoiceChangerWorkletNode extends AudioWorkletNode {
  private listener: VoiceChangerWorkletListener;

  private setting: WorkletNodeSetting = DefaultClientSettng.workletNodeSetting;
  private requestChunks: ArrayBuffer[] = [];
  private socket: Socket<DefaultEventsMap, DefaultEventsMap> | null = null;
  // performance monitor
  private bufferStart = 0;

  private isOutputRecording = false;
  private recordingOutputChunk: Float32Array[] = [];
  private outputNode: VoiceChangerWorkletNode | null = null;

  // Promises
  private startPromiseResolve:
    | ((value: void | PromiseLike<void>) => void)
    | null = null;
  private stopPromiseResolve:
    | ((value: void | PromiseLike<void>) => void)
    | null = null;

  // InternalCallback
  private internalCallback: InternalCallback | null = null;

  constructor(context: AudioContext, listener: VoiceChangerWorkletListener) {
    super(context, "voice-changer-worklet-processor");
    this.port.onmessage = this.handleMessage.bind(this);
    this.listener = listener;
    console.log(`[worklet_node][voice-changer-worklet-processor] created.`);
  }

  setOutputNode = (outputNode: VoiceChangerWorkletNode | null) => {
    this.outputNode = outputNode;
  };

  // 設定
  updateSetting = (setting: WorkletNodeSetting) => {
    console.log(
      `[WorkletNode] Updating WorkletNode Setting,`,
      this.setting,
      setting
    );
    let recreateSocketIoRequired = false;
    if (
      this.setting.serverUrl != setting.serverUrl ||
      this.setting.protocol != setting.protocol
    ) {
      recreateSocketIoRequired = true;
    }
    this.setting = setting;
    if (recreateSocketIoRequired) {
      this.createSocketIO();
    }
  };

  setInternalAudioProcessCallback = (internalCallback: InternalCallback) => {
    this.internalCallback = internalCallback;
  };

  getSettings = (): WorkletNodeSetting => {
    return this.setting;
  };

  getSocketId = () => {
    return this.socket?.id;
  };

  // 処理
  createSocketIO = () => {
    if (this.socket) {
      this.socket.close();
    }
    if (this.setting.protocol === "sio") {
      this.socket = io(this.setting.serverUrl + "/test");
      this.socket.on("connect_error", (err) => {
        this.listener.notifyException(
          VOICE_CHANGER_CLIENT_EXCEPTION.ERR_SIO_CONNECT_FAILED,
          `[SIO] rconnection failed ${err}`
        );
      });
      this.socket.on("connect", () => {
        console.log(`[SIO] connect to ${this.setting.serverUrl}`);
        console.log(`[SIO] ${this.socket?.id}`);
      });
      this.socket.on("close", function (socket) {
        console.log(`[SIO] close ${socket.id}`);
      });

      this.socket.on("message", (response: any[]) => {
        console.log("message:", response);
      });

      this.socket.on("response", (response: any[]) => {
        const cur = Date.now();
        const responseTime = cur - response[0];
        const result = response[1] as ArrayBuffer;
        const perf = response[2];

        // Quick hack for server device mode
        if (response[0] == 0) {
          this.listener.notifyResponseTime(
            Math.round(perf[0] * 1000),
            perf.slice(1, 4)
          );
          return;
        }

        if (result.byteLength < 128 * 2) {
          this.listener.notifyException(
            VOICE_CHANGER_CLIENT_EXCEPTION.ERR_SIO_INVALID_RESPONSE,
            `[SIO] recevied data is too short ${result.byteLength}`
          );
        } else {
          if (this.outputNode != null) {
            this.outputNode.postReceivedVoice(response[1]);
          } else {
            this.postReceivedVoice(response[1]);
          }
          this.listener.notifyResponseTime(responseTime, perf);
        }
      });
    }
  };

  postReceivedVoice = (data: ArrayBuffer) => {
    // Int16 to Float
    const i16Data = new Int16Array(data);
    const f32Data = new Float32Array(i16Data.length);
    // console.log(`[worklet] f32DataLength${f32Data.length} i16DataLength${i16Data.length}`)
    for (let i = 0; i < i16Data.length; i++) {
      const x = i16Data[i];
      f32Data[i] = x >= 0x8000 ? -(0x10000 - x) / 0x8000 : x / 0x7fff;
    }

    const req: VoiceChangerWorkletProcessorRequest = {
      requestType: "voice",
      voice: f32Data,
      numTrancateTreshold: 0,
      volTrancateThreshold: 0,
      volTrancateLength: 0,
    };
    this.port.postMessage(req);

    if (this.isOutputRecording) {
      this.recordingOutputChunk.push(f32Data);
    }
  };

  handleMessage(event: any) {
    // console.log(`[Node:handleMessage_] `, event.data.volume);
    if (event.data.responseType === "start_ok") {
      if (this.startPromiseResolve) {
        this.startPromiseResolve();
        this.startPromiseResolve = null;
      }
    } else if (event.data.responseType === "stop_ok") {
      if (this.stopPromiseResolve) {
        this.stopPromiseResolve();
        this.stopPromiseResolve = null;
      }
    } else if (event.data.responseType === "volume") {
      this.listener.notifyVolume(event.data.volume as number);
    } else if (event.data.responseType === "inputData") {
      const inputData = event.data.inputData as Float32Array;
      // console.log("receive input data", inputData);

      // Float to Int16 (internalの場合はfloatのまま行く。)
      if (this.setting.protocol != "internal") {
        const arrayBuffer = new ArrayBuffer(inputData.length * 2);
        const dataView = new DataView(arrayBuffer);
        for (let i = 0; i < inputData.length; i++) {
          let s = Math.max(-1, Math.min(1, inputData[i]));
          s = s < 0 ? s * 0x8000 : s * 0x7fff;
          dataView.setInt16(i * 2, s, true);
        }
        // バッファリング
        this.requestChunks.push(arrayBuffer);
      } else {
        // internal
        // console.log("inputData.buffer", inputData.buffer);
        this.requestChunks.push(inputData.buffer);
      }

      //// リクエストバッファの中身が、リクエスト送信数と違う場合は処理終了。
      if (this.requestChunks.length < this.setting.inputChunkNum) {
        return;
      }

      // リクエスト用の入れ物を作成
      const windowByteLength = this.requestChunks.reduce((prev, cur) => {
        return prev + cur.byteLength;
      }, 0);
      const newBuffer = new Uint8Array(windowByteLength);

      // リクエストのデータをセット
      this.requestChunks.reduce((prev, cur) => {
        newBuffer.set(new Uint8Array(cur), prev);
        return prev + cur.byteLength;
      }, 0);

      this.sendBuffer(newBuffer);
      this.requestChunks = [];

      this.listener.notifySendBufferingTime(Date.now() - this.bufferStart);
      this.bufferStart = Date.now();
    } else {
      console.warn(
        `[worklet_node][voice-changer-worklet-processor] unknown response ${event.data.responseType}`,
        event.data
      );
    }
  }

  private sendBuffer = async (newBuffer: Uint8Array) => {
    const timestamp = Date.now();
    if (this.setting.protocol === "sio") {
      if (!this.socket) {
        console.warn(`sio is not initialized`);
        return;
      }
      // console.log("emit!")
      this.socket.emit("request_message", [timestamp, newBuffer.buffer]);
    } else if (this.setting.protocol === "rest") {
      const restClient = new ServerRestClient(this.setting.serverUrl);
      const { changedVoiceBuffer, perf } = await restClient.postVoice(timestamp, newBuffer.buffer);
      if (changedVoiceBuffer.byteLength < 128 * 2) {
        this.listener.notifyException(
          VOICE_CHANGER_CLIENT_EXCEPTION.ERR_SIO_INVALID_RESPONSE,
          `[REST] recevied data is too short ${changedVoiceBuffer.byteLength}`
        );
      } else {
        if (this.outputNode != null) {
          this.outputNode.postReceivedVoice(changedVoiceBuffer);
        } else {
          this.postReceivedVoice(changedVoiceBuffer);
        }
      }
      this.listener.notifyResponseTime(Date.now() - timestamp, perf);
    } else if (this.setting.protocol == "internal") {
      if (!this.internalCallback) {
        this.listener.notifyException(
          VOICE_CHANGER_CLIENT_EXCEPTION.ERR_INTERNAL_AUDIO_PROCESS_CALLBACK_IS_NOT_INITIALIZED,
          `[AudioWorkletNode] internal audio process callback is not initialized`
        );
        return;
      }
      // const res = await this.internalCallback.processAudio(newBuffer);
      // if (res.length < 128 * 2) {
      //     return;
      // }
      // if (this.outputNode != null) {
      //     this.outputNode.postReceivedVoice(res.buffer);
      // } else {
      //     this.postReceivedVoice(res.buffer);
      // }
      this.internalCallback.processAudio(newBuffer).then((res) => {
        if (res.length < 128 * 2) {
          return;
        }
        if (this.outputNode != null) {
          this.outputNode.postReceivedVoice(res.buffer);
        } else {
          this.postReceivedVoice(res.buffer);
        }
      });
    } else {
      throw "unknown protocol";
    }
  };

  // Worklet操作
  configure = (setting: WorkletSetting) => {
    const req: VoiceChangerWorkletProcessorRequest = {
      requestType: "config",
      voice: new Float32Array(1),
      numTrancateTreshold: setting.numTrancateTreshold,
      volTrancateThreshold: setting.volTrancateThreshold,
      volTrancateLength: setting.volTrancateLength,
    };
    this.port.postMessage(req);
  };

  start = async () => {
    const p = new Promise<void>((resolve) => {
      this.startPromiseResolve = resolve;
    });
    const req: VoiceChangerWorkletProcessorRequest = {
      requestType: "start",
      voice: new Float32Array(1),
      numTrancateTreshold: 0,
      volTrancateThreshold: 0,
      volTrancateLength: 0,
    };
    this.port.postMessage(req);
    await p;
  };
  stop = async () => {
    const p = new Promise<void>((resolve) => {
      this.stopPromiseResolve = resolve;
    });
    const req: VoiceChangerWorkletProcessorRequest = {
      requestType: "stop",
      voice: new Float32Array(1),
      numTrancateTreshold: 0,
      volTrancateThreshold: 0,
      volTrancateLength: 0,
    };
    this.port.postMessage(req);
    await p;
  };
  trancateBuffer = () => {
    const req: VoiceChangerWorkletProcessorRequest = {
      requestType: "trancateBuffer",
      voice: new Float32Array(1),
      numTrancateTreshold: 0,
      volTrancateThreshold: 0,
      volTrancateLength: 0,
    };
    this.port.postMessage(req);
  };

  startOutputRecording = () => {
    this.recordingOutputChunk = [];
    this.isOutputRecording = true;
  };
  stopOutputRecording = () => {
    this.isOutputRecording = false;

    const dataSize = this.recordingOutputChunk.reduce((prev, cur) => {
      return prev + cur.length;
    }, 0);
    const samples = new Float32Array(dataSize);
    let sampleIndex = 0;
    for (let i = 0; i < this.recordingOutputChunk.length; i++) {
      for (let j = 0; j < this.recordingOutputChunk[i].length; j++) {
        samples[sampleIndex] = this.recordingOutputChunk[i][j];
        sampleIndex++;
      }
    }
    return samples;
  };
}
