import {
  Stability,
  StoreKey,
  ACCESS_CODE_PREFIX,
  ApiPath,
} from "@/app/constant";
import { getBearerToken } from "@/app/client/api";
import { createPersistStore } from "@/app/utils/store";
import { nanoid } from "nanoid";
import { uploadImage, base64Image2Blob } from "@/app/utils/chat";
import { models, getModelParamBasicData } from "@/app/components/sd/sd-panel";
import { useAccessStore } from "./access";
import { BedrockApi } from "@/app/client/platforms/bedrock";

const defaultModel = {
  name: models[0].name,
  value: models[0].value,
};

const defaultParams = getModelParamBasicData(models[0].params({}), {});

const DEFAULT_SD_STATE = {
  currentId: 0,
  draw: [],
  currentModel: defaultModel,
  currentParams: defaultParams,
};

export const useSdStore = createPersistStore<
  {
    currentId: number;
    draw: any[];
    currentModel: typeof defaultModel;
    currentParams: any;
  },
  {
    getNextId: () => number;
    sendTask: (data: any, okCall?: Function) => void;
    updateDraw: (draw: any) => void;
    setCurrentModel: (model: any) => void;
    setCurrentParams: (data: any) => void;
  }
>(
  DEFAULT_SD_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    const methods = {
      getNextId() {
        const id = ++_get().currentId;
        set({ currentId: id });
        return id;
      },
      sendTask(data: any, okCall?: Function) {
        const currentModel = _get().currentModel;
        const currentParams = _get().currentParams;

        data = { ...data, id: nanoid(), status: "running" };
        set({ draw: [data, ..._get().draw] });
        this.getNextId();
        console.log("Sending Bedrock model:", currentModel.value);
        console.log("Sending Bedrock request with model:", currentParams.model);

        // Handle different model types
        if (
          currentModel.value === "bedrock-sd" ||
          currentModel.value === "bedrock-titan" ||
          currentModel.value === "bedrock-nova"
        ) {
          const modelData = {
            ...data,
            params: {
              ...data.params,
              model: currentParams.model, // Use the selected model from currentParams
            },
          };
          this.bedrockRequestCall(modelData);
        } else {
          this.stabilityRequestCall(data);
        }

        okCall?.();
      },
      stabilityRequestCall(data: any) {
        const accessStore = useAccessStore.getState();
        let prefix: string = ApiPath.Stability as string;
        let bearerToken = "";
        if (accessStore.useCustomConfig) {
          prefix = accessStore.stabilityUrl || (ApiPath.Stability as string);
          bearerToken = getBearerToken(accessStore.stabilityApiKey);
        }
        if (!bearerToken && accessStore.enabledAccessControl()) {
          bearerToken = getBearerToken(
            ACCESS_CODE_PREFIX + accessStore.accessCode,
          );
        }
        const headers = {
          Accept: "application/json",
          Authorization: bearerToken,
        };
        const path = `${prefix}/${Stability.GeneratePath}/${data.model}`;
        const formData = new FormData();
        for (let paramsKey in data.params) {
          formData.append(paramsKey, data.params[paramsKey]);
        }
        fetch(path, {
          method: "POST",
          headers,
          body: formData,
        })
          .then((response) => response.json())
          .then((resData) => {
            if (resData.errors && resData.errors.length > 0) {
              this.updateDraw({
                ...data,
                status: "error",
                error: resData.errors[0],
              });
              this.getNextId();
              return;
            }
            const self = this;
            if (resData.finish_reason === "SUCCESS") {
              uploadImage(base64Image2Blob(resData.image, "image/png"))
                .then((img_data) => {
                  console.debug("uploadImage success", img_data, self);
                  self.updateDraw({
                    ...data,
                    status: "success",
                    img_data,
                  });
                })
                .catch((e) => {
                  console.error("uploadImage error", e);
                  self.updateDraw({
                    ...data,
                    status: "error",
                    error: JSON.stringify(e),
                  });
                });
            } else {
              self.updateDraw({
                ...data,
                status: "error",
                error: JSON.stringify(resData),
              });
            }
            this.getNextId();
          })
          .catch((error) => {
            this.updateDraw({ ...data, status: "error", error: error.message });
            console.error("Error:", error);
            this.getNextId();
          });
      },
      async bedrockRequestCall(data: any) {
        try {
          const bedrockApi = new BedrockApi();
          const result = await bedrockApi.generateImage(data.params);

          if (result.base64) {
            const self = this;
            uploadImage(base64Image2Blob(result.base64, "image/png"))
              .then((img_data) => {
                console.debug("uploadImage success", img_data, self);
                self.updateDraw({
                  ...data,
                  status: "success",
                  img_data,
                });
              })
              .catch((e) => {
                console.error("uploadImage error", e);
                self.updateDraw({
                  ...data,
                  status: "error",
                  error: JSON.stringify(e),
                });
              });
          } else {
            this.updateDraw({
              ...data,
              status: "error",
              error: "No image data in response",
            });
          }
        } catch (error) {
          this.updateDraw({
            ...data,
            status: "error",
            error: error instanceof Error ? error.message : "Unknown error",
          });
          console.error("Bedrock Error:", error);
        }
        this.getNextId();
      },
      updateDraw(_draw: any) {
        const draw = _get().draw || [];
        draw.some((item, index) => {
          if (item.id === _draw.id) {
            draw[index] = _draw;
            set(() => ({ draw }));
            return true;
          }
        });
      },
      setCurrentModel(model: any) {
        set({ currentModel: model });
      },
      setCurrentParams(data: any) {
        set({
          currentParams: data,
        });
      },
    };

    return methods;
  },
  {
    name: StoreKey.SdList,
    version: 1.0,
  },
);
