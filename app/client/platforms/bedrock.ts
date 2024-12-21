"use client";
import { ChatOptions, getHeaders, LLMApi, SpeechOptions } from "../api";
import {
  useAppConfig,
  usePluginStore,
  useChatStore,
  useAccessStore,
  ChatMessageTool,
} from "@/app/store";
import { preProcessImageContent } from "@/app/utils/chat";
import { getMessageTextContent, isVisionModel } from "@/app/utils";
import {
  ApiPath,
  BEDROCK_BASE_URL,
  REQUEST_TIMEOUT_MS,
  Bedrock,
} from "@/app/constant";
import { getClientConfig } from "@/app/config/client";
import {
  extractMessage,
  processMessage,
  processChunks,
  parseEventData,
  sign,
} from "@/app/utils/aws";
import { prettyObject } from "@/app/utils/format";
import Locale from "@/app/locales";
import { encrypt } from "@/app/utils/aws";

const ClaudeMapper = {
  assistant: "assistant",
  user: "user",
  system: "user",
} as const;

const MistralMapper = {
  system: "system",
  user: "user",
  assistant: "assistant",
} as const;
type MistralRole = keyof typeof MistralMapper;

interface Tool {
  function?: {
    name?: string;
    description?: string;
    parameters?: any;
  };
}
const isApp = !!getClientConfig()?.isApp;
// const isApp = true;
async function getBedrockHeaders(
  modelId: string,
  chatPath: string,
  finalRequestBody: any,
  shouldStream: boolean,
  isAsync: boolean = false,
): Promise<Record<string, string>> {
  const accessStore = useAccessStore.getState();
  const bedrockHeaders = isApp
    ? await sign({
        method: "POST",
        url: chatPath,
        region: accessStore.awsRegion,
        accessKeyId: accessStore.awsAccessKey,
        secretAccessKey: accessStore.awsSecretKey,
        body: finalRequestBody,
        service: "bedrock",
        headers: {},
        isStreaming: shouldStream,
      })
    : getHeaders();

  if (!isApp) {
    const { awsRegion, awsAccessKey, awsSecretKey, encryptionKey } =
      accessStore;

    const bedrockHeadersConfig = {
      XModelID: modelId,
      XEncryptionKey: encryptionKey,
      ShouldStream: String(shouldStream),
      IsAsync: String(isAsync),
      Authorization: await createAuthHeader(
        awsRegion,
        awsAccessKey,
        awsSecretKey,
        encryptionKey,
      ),
    };

    Object.assign(bedrockHeaders, bedrockHeadersConfig);
  }

  return bedrockHeaders;
}

// Helper function to create Authorization header
async function createAuthHeader(
  region: string,
  accessKey: string,
  secretKey: string,
  encryptionKey: string,
): Promise<string> {
  const encryptedValues = await Promise.all([
    encrypt(region, encryptionKey),
    encrypt(accessKey, encryptionKey),
    encrypt(secretKey, encryptionKey),
  ]);

  return `Bearer ${encryptedValues.join(":")}`;
}
export class BedrockApi implements LLMApi {
  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Speech not implemented for Bedrock.");
  }

  async checkVideoStatus(invocationArn: string) {
    try {
      const bedrockAPIPath = `${BEDROCK_BASE_URL}/async-invoke/${invocationArn}`;
      const statusPath = isApp
        ? bedrockAPIPath
        : ApiPath.Bedrock + "/async-invoke";

      const headers = await getBedrockHeaders(
        "amazon.nova-reel-v1:0",
        statusPath,
        "",
        false,
        true, // Set isAsync to true for video status check
      );

      const res = await fetch(statusPath, {
        method: "GET",
        headers,
      });

      if (!res.ok) {
        throw new Error(`Failed to check video status: ${res.statusText}`);
      }

      const data = await res.json();

      return {
        status: data.status, // "Completed", "InProgress", or "Failed"
        s3Output: {
          manifestPath: data.outputMetadata?.manifestS3Path, // Path to manifest.json
          videoPath: data.outputMetadata?.videoS3Path, // Path to output.mp4
        },
        error: data.failureReason, // Error message if status is "Failed"
        completionTime: data.completionTime, // Timestamp when the job completed
        requestTime: data.requestTime, // Timestamp when the job was requested
      };
    } catch (e) {
      console.error("[Bedrock Video Status Check Error]:", e);
      throw e;
    }
  }

  formatImageRequestBody(params: any) {
    const model = params.model;

    // Handle Bedrock Stable Diffusion
    if (model.includes("stability")) {
      return {
        prompt: params.prompt,
        negative_prompt: params.negative_prompt || "",
        mode: "text-to-image",
        seed: params.seed || 0,
        aspect_ratio: params.aspectRatio || "1:1",
        output_format: params.output_format || "png",
      };
    }

    // Handle Nova Reel video generation
    if (model.includes("amazon.nova-reel")) {
      interface ImageSource {
        format: "jpeg" | "png";
        source: {
          bytes: string;
        };
      }

      interface NovaReelRequest {
        taskType: "TEXT_VIDEO";
        textToVideoParams: {
          text: string;
          images?: ImageSource[];
        };
        videoGenerationConfig: {
          durationSeconds: number;
          fps: number;
          dimension: string;
          seed: number;
        };
      }

      const requestBody: NovaReelRequest = {
        taskType: "TEXT_VIDEO",
        textToVideoParams: {
          text: params.prompt,
          ...(params.images?.[0] && {
            images: [
              {
                format: params.images[0].format || "jpeg",
                source: {
                  bytes: params.images[0].base64,
                },
              },
            ],
          }),
        },
        videoGenerationConfig: {
          durationSeconds: 6,
          fps: 24,
          dimension: "1280x720",
          seed: params.seed || 12,
        },
      };

      return {
        body: requestBody,
        outputConfig: {
          s3OutputDataConfig: {
            s3Uri: params.s3OutputPath || "s3://nova-test-videos-us-west-2",
          },
        },
      };
    }

    // Handle Titan image generation
    if (model.includes("amazon.titan-image")) {
      const [width, height] = params.size.split("x").map(Number);
      return {
        taskType: "TEXT_IMAGE",
        textToImageParams: {
          text: params.prompt,
          negativeText:
            params.negative_prompt ||
            "blurry, distorted, low resolution, pixelated, overexposed, underexposed, dark, grainy, noisy, watermark",
        },
        imageGenerationConfig: {
          numberOfImages: params.numberOfImages || 1,
          quality: params.quality || "standard",
          height: height || 768,
          width: width || 1280,
          cfgScale: Math.min(
            Math.max(parseFloat(params.cfg_scale) || 7.5, 1.1),
            10.0,
          ),
          seed: params.seed || Math.floor(Math.random() * 214783647),
        },
      };
    }

    // Handle Nova Canvas image generation
    if (model.includes("amazon.nova-canvas")) {
      const [width, height] = params.size.split("x").map(Number);
      return {
        taskType: "TEXT_IMAGE",
        textToImageParams: {
          text: params.prompt,
          negativeText:
            params.negative_prompt ||
            "blurry, distorted, low resolution, pixelated, overexposed, underexposed, dark, grainy, noisy, watermark",
        },
        imageGenerationConfig: {
          width: width || 1024,
          height: height || 1024,
          quality: params.quality || "standard",
          seed: params.seed || Math.floor(Math.random() * 214783647),
          numberOfImages: params.numberOfImages || 1,
        },
      };
    }

    throw new Error(`Unsupported image model: ${model}`);
  }

  async generateImage(params: any) {
    try {
      const requestBody = this.formatImageRequestBody(params);
      const isVideoRequest =
        params.model === Bedrock.ImageModels.NovaCanvasAndReel.NovaReel;

      const bedrockAPIPath = `${BEDROCK_BASE_URL}/model/${params.model}/${
        isVideoRequest ? "start-async-invoke" : "invoke"
      }`;
      const imagePath = isApp
        ? bedrockAPIPath
        : ApiPath.Bedrock + (isVideoRequest ? "/async-invoke" : "/images");

      const headers = await getBedrockHeaders(
        params.model,
        imagePath,
        JSON.stringify(requestBody),
        false,
        isVideoRequest, // Pass isVideoRequest as isAsync parameter
      );

      const res = await fetch(imagePath, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error("[Bedrock Error]", errorText);
        throw new Error(`Failed to generate media: ${errorText}`);
      }

      const data = await res.json();

      // Handle async video generation
      if (isVideoRequest) {
        return {
          invocationArn: data.invocationArn,
          isVideo: true,
          isAsync: true,
        };
      }

      // Handle synchronous image generation
      let mediaData;
      if (params.model.includes("stability.stable-diffusion")) {
        mediaData = data.artifacts?.[0]?.base64;
      } else if (params.model.includes("amazon.titan-image")) {
        mediaData = data.images?.[0];
      } else if (params.model.includes("amazon.nova-canvas")) {
        mediaData = data.images?.[0];
      }

      if (!mediaData) {
        throw new Error("No media data in response");
      }

      return {
        base64: mediaData,
        isVideo: false,
        isAsync: false,
      };
    } catch (e) {
      console.error("[Bedrock Media Generation Error]:", e);
      throw e;
    }
  }

  formatRequestBody(messages: ChatOptions["messages"], modelConfig: any) {
    const model = modelConfig.model;
    const visionModel = isVisionModel(modelConfig.model);

    // Get tools if available
    const [tools] = usePluginStore
      .getState()
      .getAsTools(useChatStore.getState().currentSession().mask?.plugin || []);

    const toolsArray = (tools as Tool[]) || [];

    // Handle Nova models
    if (model.includes("amazon.nova")) {
      // Extract system message if present
      const systemMessage = messages.find((m) => m.role === "system");
      const conversationMessages = messages.filter((m) => m.role !== "system");

      const requestBody: any = {
        schemaVersion: "messages-v1",
        messages: conversationMessages.map((message) => {
          const content = Array.isArray(message.content)
            ? message.content
            : [{ text: getMessageTextContent(message) }];

          return {
            role: message.role,
            content: content.map((item: any) => {
              // Handle text content
              if (item.text || typeof item === "string") {
                return { text: item.text || item };
              }
              // Handle image content
              if (item.image_url?.url) {
                const { url = "" } = item.image_url;
                const colonIndex = url.indexOf(":");
                const semicolonIndex = url.indexOf(";");
                const comma = url.indexOf(",");

                // Extract format from mime type
                const mimeType = url.slice(colonIndex + 1, semicolonIndex);
                const format = mimeType.split("/")[1];
                const data = url.slice(comma + 1);

                return {
                  image: {
                    format,
                    source: {
                      bytes: data,
                    },
                  },
                };
              }
              return item;
            }),
          };
        }),
        inferenceConfig: {
          temperature: modelConfig.temperature || 0.7,
          top_p: modelConfig.top_p || 0.9,
          top_k: modelConfig.top_k || 50,
          max_new_tokens: modelConfig.max_tokens || 1000,
          stopSequences: modelConfig.stop || [],
        },
      };

      // Add system message if present
      if (systemMessage) {
        requestBody.system = [
          {
            text: getMessageTextContent(systemMessage),
          },
        ];
      }

      // Add tools if available - exact Nova format
      if (toolsArray.length > 0) {
        requestBody.toolConfig = {
          tools: toolsArray.map((tool) => ({
            toolSpec: {
              name: tool?.function?.name || "",
              description: tool?.function?.description || "",
              inputSchema: {
                json: {
                  type: "object",
                  properties: tool?.function?.parameters?.properties || {},
                  required: tool?.function?.parameters?.required || [],
                },
              },
            },
          })),
          toolChoice: { auto: {} },
        };
      }

      return requestBody;
    }

    // Handle Titan models
    if (model.startsWith("amazon.titan")) {
      const inputText = messages
        .map((message) => {
          return `${message.role}: ${getMessageTextContent(message)}`;
        })
        .join("\n\n");

      return {
        inputText,
        textGenerationConfig: {
          maxTokenCount: modelConfig.max_tokens,
          temperature: modelConfig.temperature,
          stopSequences: [],
        },
      };
    }

    // Handle LLaMA models
    if (model.includes("meta.llama")) {
      let prompt = "<|begin_of_text|>";

      // Extract system message if present
      const systemMessage = messages.find((m) => m.role === "system");
      if (systemMessage) {
        prompt += `<|start_header_id|>system<|end_header_id|>\n${getMessageTextContent(
          systemMessage,
        )}<|eot_id|>`;
      }

      // Format the conversation
      const conversationMessages = messages.filter((m) => m.role !== "system");
      for (const message of conversationMessages) {
        const role = message.role === "assistant" ? "assistant" : "user";
        const content = getMessageTextContent(message);
        prompt += `<|start_header_id|>${role}<|end_header_id|>\n${content}<|eot_id|>`;
      }

      // Add the final assistant header to prompt completion
      prompt += "<|start_header_id|>assistant<|end_header_id|>";

      return {
        prompt,
        max_gen_len: modelConfig.max_tokens || 512,
        temperature: modelConfig.temperature || 0.7,
        top_p: modelConfig.top_p || 0.9,
      };
    }

    // Handle Mistral models
    if (model.includes("mistral.mistral")) {
      const formattedMessages = messages.map((message) => ({
        role: MistralMapper[message.role as MistralRole] || "user",
        content: getMessageTextContent(message),
      }));

      const requestBody: any = {
        messages: formattedMessages,
        max_tokens: modelConfig.max_tokens || 4096,
        temperature: modelConfig.temperature || 0.7,
        top_p: modelConfig.top_p || 0.9,
      };

      // Add tools if available
      if (toolsArray.length > 0) {
        requestBody.tool_choice = "auto";
        requestBody.tools = toolsArray.map((tool) => ({
          type: "function",
          function: {
            name: tool?.function?.name,
            description: tool?.function?.description,
            parameters: tool?.function?.parameters,
          },
        }));
      }

      return requestBody;
    }

    // Handle Claude models
    const keys = ["system", "user"];
    // roles must alternate between "user" and "assistant" in claude, so add a fake assistant message between two user messages
    for (let i = 0; i < messages.length - 1; i++) {
      const message = messages[i];
      const nextMessage = messages[i + 1];

      if (keys.includes(message.role) && keys.includes(nextMessage.role)) {
        messages[i] = [
          message,
          {
            role: "assistant",
            content: ";",
          },
        ] as any;
      }
    }
    const prompt = messages
      .flat()
      .filter((v) => {
        if (!v.content) return false;
        if (typeof v.content === "string" && !v.content.trim()) return false;
        return true;
      })
      .map((v) => {
        const { role, content } = v;
        const insideRole = ClaudeMapper[role] ?? "user";

        if (!visionModel || typeof content === "string") {
          return {
            role: insideRole,
            content: getMessageTextContent(v),
          };
        }
        return {
          role: insideRole,
          content: content
            .filter((v) => v.image_url || v.text)
            .map(({ type, text, image_url }) => {
              if (type === "text") {
                return {
                  type,
                  text: text!,
                };
              }
              const { url = "" } = image_url || {};
              const colonIndex = url.indexOf(":");
              const semicolonIndex = url.indexOf(";");
              const comma = url.indexOf(",");

              const mimeType = url.slice(colonIndex + 1, semicolonIndex);
              const encodeType = url.slice(semicolonIndex + 1, comma);
              const data = url.slice(comma + 1);

              return {
                type: "image" as const,
                source: {
                  type: encodeType,
                  media_type: mimeType,
                  data,
                },
              };
            }),
        };
      });

    if (prompt[0]?.role === "assistant") {
      prompt.unshift({
        role: "user",
        content: ";",
      });
    }
    const requestBody: any = {
      anthropic_version: useAccessStore.getState().bedrockAnthropicVersion,
      max_tokens: modelConfig.max_tokens,
      messages: prompt,
      temperature: modelConfig.temperature,
      top_p: modelConfig.top_p || 0.9,
      top_k: modelConfig.top_k || 5,
    };

    // Add tools if available for Claude models
    if (toolsArray.length > 0 && model.includes("anthropic.claude")) {
      requestBody.tools = toolsArray.map((tool) => ({
        name: tool?.function?.name || "",
        description: tool?.function?.description || "",
        input_schema: tool?.function?.parameters || {},
      }));
    }

    return requestBody;
  }

  async chat(options: ChatOptions) {
    const accessStore = useAccessStore.getState();

    const shouldStream = !!options.config.stream;

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };

    // try get base64image from local cache image_url
    const messages: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      const content = await preProcessImageContent(v.content);
      messages.push({ role: v.role, content });
    }

    const controller = new AbortController();
    options.onController?.(controller);

    let finalRequestBody = this.formatRequestBody(messages, modelConfig);

    try {
      const bedrockAPIPath = `${BEDROCK_BASE_URL}/model/${
        modelConfig.model
      }/invoke${shouldStream ? "-with-response-stream" : ""}`;
      const chatPath = isApp ? bedrockAPIPath : ApiPath.Bedrock + "/chat";

      if (process.env.NODE_ENV !== "production") {
        console.debug("[Bedrock Client] Request:", {
          path: chatPath,
          model: modelConfig.model,
          messages: messages.length,
          stream: shouldStream,
        });
      }

      if (shouldStream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );
        return bedrockStream(
          modelConfig.model,
          chatPath,
          finalRequestBody,
          funcs,
          controller,
          // processToolMessage, include tool_calls message and tool call results
          (
            requestPayload: any[],
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            const modelId = modelConfig.model;
            const isMistral = modelId.includes("mistral.mistral");
            const isClaude = modelId.includes("anthropic.claude");
            const isNova = modelId.includes("amazon.nova");

            if (isClaude) {
              // Format for Claude
              // @ts-ignore
              requestPayload?.messages?.splice(
                // @ts-ignore
                requestPayload?.messages?.length,
                0,
                {
                  role: "assistant",
                  content: toolCallMessage.tool_calls.map(
                    (tool: ChatMessageTool) => ({
                      type: "tool_use",
                      id: tool.id,
                      name: tool?.function?.name,
                      input: tool?.function?.arguments
                        ? JSON.parse(tool?.function?.arguments)
                        : {},
                    }),
                  ),
                },
                // @ts-ignore
                ...toolCallResult.map((result) => ({
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: result.tool_call_id,
                      content: result.content,
                    },
                  ],
                })),
              );
            } else if (isMistral) {
              // Format for Mistral
              // @ts-ignore
              requestPayload?.messages?.splice(
                // @ts-ignore
                requestPayload?.messages?.length,
                0,
                {
                  role: "assistant",
                  content: "",
                  // @ts-ignore
                  tool_calls: toolCallMessage.tool_calls.map(
                    (tool: ChatMessageTool) => ({
                      id: tool.id,
                      function: {
                        name: tool?.function?.name,
                        arguments: tool?.function?.arguments || "{}",
                      },
                    }),
                  ),
                },
                ...toolCallResult.map((result) => ({
                  role: "tool",
                  tool_call_id: result.tool_call_id,
                  content: result.content,
                })),
              );
            } else if (isNova) {
              // Format for Nova - Updated format
              // @ts-ignore
              requestPayload?.messages?.splice(
                // @ts-ignore
                requestPayload?.messages?.length,
                0,
                {
                  role: "assistant",
                  content: [
                    {
                      toolUse: {
                        toolUseId: toolCallMessage.tool_calls[0].id,
                        name: toolCallMessage.tool_calls[0]?.function?.name,
                        input:
                          typeof toolCallMessage.tool_calls[0]?.function
                            ?.arguments === "string"
                            ? JSON.parse(
                                toolCallMessage.tool_calls[0]?.function
                                  ?.arguments,
                              )
                            : toolCallMessage.tool_calls[0]?.function
                                ?.arguments || {},
                      },
                    },
                  ],
                },
                {
                  role: "user",
                  content: [
                    {
                      toolResult: {
                        toolUseId: toolCallResult[0].tool_call_id,
                        content: [
                          {
                            json: {
                              content: toolCallResult[0].content,
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              );
            } else {
              console.warn(
                `[Bedrock Client] Unhandled model type for tool calls: ${modelId}`,
              );
            }
          },
          options,
        );
      } else {
        try {
          controller.signal.onabort = () =>
            options.onFinish("", new Response(null, { status: 400 }));
          const newHeaders = await getBedrockHeaders(
            modelConfig.model,
            chatPath,
            JSON.stringify(finalRequestBody),
            shouldStream,
            false,
          );
          const res = await fetch(chatPath, {
            method: "POST",
            headers: newHeaders,
            body: JSON.stringify(finalRequestBody),
          });
          const contentType = res.headers.get("content-type");
          console.log(
            "[Bedrock  Not Stream Request] response content type: ",
            contentType,
          );
          const resJson = await res.json();
          const message = extractMessage(resJson);
          options.onFinish(message, res);
        } catch (e) {
          const error =
            e instanceof Error ? e : new Error("Unknown error occurred");
          console.error("[Bedrock Client] Chat failed:", error.message);
          options.onError?.(error);
        }
      }
    } catch (e) {
      console.error("[Bedrock Client] Chat error:", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    return { used: 0, total: 0 };
  }

  async models() {
    return [];
  }
}

function bedrockStream(
  modelId: string,
  chatPath: string,
  requestPayload: any,
  funcs: Record<string, Function>,
  controller: AbortController,
  processToolMessage: (
    requestPayload: any,
    toolCallMessage: any,
    toolCallResult: any[],
  ) => void,
  options: any,
) {
  let responseText = "";
  let remainText = "";
  let finished = false;
  let running = false;
  let runTools: any[] = [];
  let responseRes: Response;
  let index = -1;
  let chunks: Uint8Array[] = [];
  let pendingChunk: Uint8Array | null = null;

  function animateResponseText() {
    if (finished || controller.signal.aborted) {
      responseText += remainText;
      console.log("[Response Animation] finished");
      if (responseText?.length === 0) {
        options.onError?.(new Error("empty response from server"));
      }
      return;
    }

    if (remainText.length > 0) {
      const fetchCount = Math.max(1, Math.round(remainText.length / 60));
      const fetchText = remainText.slice(0, fetchCount);
      responseText += fetchText;
      remainText = remainText.slice(fetchCount);
      options.onUpdate?.(responseText, fetchText);
    }

    requestAnimationFrame(animateResponseText);
  }

  animateResponseText();

  const finish = () => {
    if (!finished) {
      if (!running && runTools.length > 0) {
        const toolCallMessage = {
          role: "assistant",
          tool_calls: [...runTools],
        };
        running = true;
        runTools.splice(0, runTools.length);
        return Promise.all(
          toolCallMessage.tool_calls.map((tool) => {
            options?.onBeforeTool?.(tool);
            const funcName = tool?.function?.name || tool?.name;
            if (!funcName || !funcs[funcName]) {
              console.error(`Function ${funcName} not found in funcs:`, funcs);
              return Promise.reject(`Function ${funcName} not found`);
            }
            return Promise.resolve(
              funcs[funcName](
                tool?.function?.arguments
                  ? JSON.parse(tool?.function?.arguments)
                  : {},
              ),
            )
              .then((res) => {
                let content = res.data || res?.statusText;
                content =
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content);
                if (res.status >= 300) {
                  return Promise.reject(content);
                }
                return content;
              })
              .then((content) => {
                options?.onAfterTool?.({
                  ...tool,
                  content,
                  isError: false,
                });
                return content;
              })
              .catch((e) => {
                options?.onAfterTool?.({
                  ...tool,
                  isError: true,
                  errorMsg: e.toString(),
                });
                return e.toString();
              })
              .then((content) => ({
                name: funcName,
                role: "tool",
                content,
                tool_call_id: tool.id,
              }));
          }),
        ).then((toolCallResult) => {
          processToolMessage(requestPayload, toolCallMessage, toolCallResult);
          setTimeout(() => {
            console.debug("[BedrockAPI for toolCallResult] restart");
            running = false;
            bedrockChatApi(modelId, chatPath, requestPayload, true);
          }, 60);
        });
      }
      if (running) {
        return;
      }
      console.debug("[BedrockAPI] end");
      finished = true;
      options.onFinish(responseText + remainText, responseRes);
    }
  };

  controller.signal.onabort = finish;

  async function bedrockChatApi(
    modelId: string,
    chatPath: string,
    requestPayload: any,
    shouldStream: boolean,
  ) {
    const requestTimeoutId = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    const newHeaders = await getBedrockHeaders(
      modelId,
      chatPath,
      JSON.stringify(requestPayload),
      shouldStream,
      false, // Chat operations are never async
    );
    try {
      const res = await fetch(chatPath, {
        method: "POST",
        headers: newHeaders,
        body: JSON.stringify(requestPayload),
        redirect: "manual",
        // @ts-ignore
        duplex: "half",
        signal: controller.signal,
      });

      clearTimeout(requestTimeoutId);
      responseRes = res;

      const contentType = res.headers.get("content-type");
      // console.log(
      //   "[Bedrock Stream Request] response content type: ",
      //   contentType,
      // );

      if (contentType?.startsWith("text/plain")) {
        responseText = await res.text();
        return finish();
      }

      if (
        !res.ok ||
        res.status !== 200 ||
        !contentType?.startsWith("application/vnd.amazon.eventstream")
      ) {
        const responseTexts = [responseText];
        let extraInfo = await res.text();
        try {
          const resJson = await res.clone().json();
          extraInfo = prettyObject(resJson);
        } catch {}

        if (res.status === 401) {
          responseTexts.push(Locale.Error.Unauthorized);
        }

        if (extraInfo) {
          responseTexts.push(extraInfo);
        }

        responseText = responseTexts.join("\n\n");
        return finish();
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("No response body reader available");
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (pendingChunk) {
              try {
                const parsed = parseEventData(pendingChunk);
                if (parsed) {
                  const result = processMessage(
                    parsed,
                    remainText,
                    runTools,
                    index,
                  );
                  remainText = result.remainText;
                  index = result.index;
                }
              } catch (e) {
                console.error("[Final Chunk Process Error]:", e);
              }
            }
            break;
          }

          chunks.push(value);

          const result = processChunks(
            chunks,
            pendingChunk,
            remainText,
            runTools,
            index,
          );
          chunks = result.chunks;
          pendingChunk = result.pendingChunk;
          remainText = result.remainText;
          index = result.index;
        }
      } catch (err) {
        console.error(
          "[Bedrock Stream]:",
          err instanceof Error ? err.message : "Stream processing failed",
        );
        throw new Error("Failed to process stream response");
      } finally {
        reader.releaseLock();
        finish();
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        console.log("[Bedrock Client] Aborted by user");
        return;
      }
      console.error(
        "[Bedrock Request] Failed:",
        e instanceof Error ? e.message : "Request failed",
      );
      options.onError?.(e);
      throw new Error("Request processing failed");
    }
  }

  console.debug("[BedrockAPI] start");
  bedrockChatApi(modelId, chatPath, requestPayload, true);
}
