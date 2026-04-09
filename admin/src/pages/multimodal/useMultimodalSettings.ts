import { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchBotApi, settingsApi } from '../../api/appwrite';
import { settingsSchema, type SettingsForm, mapSettingsToFormValues } from './settingsSchema';
import {
  DEFAULT_AUDIO_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PROMPT,
  DEFAULT_VISION_MAX_TOKENS,
  type VisionModel,
  type ImageModel,
  type AudioRuntimeState,
  type ModelTestResult,
} from './multimodalConstants';

export function useMultimodalSettings() {
  const queryClient = useQueryClient();
  const [saveMessage, setSaveMessage] = useState('');
  const [visionModels, setVisionModels] = useState<VisionModel[]>([]);
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [isRefreshingVision, setIsRefreshingVision] = useState(false);
  const [isRefreshingImage, setIsRefreshingImage] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [audioRuntimeState, setAudioRuntimeState] = useState<AudioRuntimeState | null>(null);
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [modelTestResults, setModelTestResults] = useState<Record<string, ModelTestResult>>({});

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  const { data: runtimeTruth } = useQuery({
    queryKey: ['settings-runtime-truth'],
    queryFn: settingsApi.getRuntimeTruth,
  });

  const fetchVisionModels = useCallback(async (force = false) => {
    try {
      setIsRefreshingVision(true);
      const endpoint = force ? '/api/models/vision/refresh' : '/api/models/vision';
      const method = force ? 'POST' : 'GET';
      const response = await fetchBotApi(endpoint, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      });
      if (response.ok) {
        const result = await response.json();
        const models = result.data?.models;
        if (models && models.length > 0) {
          setVisionModels(models);
          if (force) {
            setRefreshMessage(`Загружено ${models.length} моделей. Автотест...`);
            let tested = 0;
            let ok = 0;
            for (const m of models) {
              try {
                const resp = await fetchBotApi('/api/models/vision/test', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: m.id }),
                });
                const json = await resp.json();
                const isOk = json.status === 'ok';
                if (isOk) ok++;
                tested++;
                setModelTestResults(prev => ({
                  ...prev,
                  [m.id]: { status: isOk ? 'ok' : 'error', latencyMs: json.latencyMs || 0, detail: json.detail, error: json.error },
                }));
                setRefreshMessage(`Тест ${tested}/${models.length}... (${ok} рабочих)`);
              } catch {
                tested++;
                setModelTestResults(prev => ({ ...prev, [m.id]: { status: 'error', latencyMs: 0, error: 'Сетевая ошибка' } }));
              }
            }
            setRefreshMessage(`✅ ${ok}/${models.length} моделей рабочие`);
            setTimeout(() => setRefreshMessage(''), 5000);
          }
        }
      } else {
        const errorText = await response.text();
        if (force) {
          setRefreshMessage(`Ошибка ${response.status}: ${errorText || 'не удалось загрузить модели'}`);
          setTimeout(() => setRefreshMessage(''), 5000);
        }
      }
    } catch (err) {
      if (force) {
        const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
        setRefreshMessage(`Ошибка загрузки моделей: ${msg}`);
        setTimeout(() => setRefreshMessage(''), 5000);
      }
    } finally {
      setIsRefreshingVision(false);
    }
  }, []);

  const fetchAudioState = useCallback(async () => {
    try {
      const response = await fetchBotApi('/api/models/audio');
      if (!response.ok) {
        setAudioRuntimeState(null);
        return;
      }
      const result = await response.json();
      setAudioRuntimeState({
        preferredModel: result.data?.preferredModel || DEFAULT_AUDIO_MODEL,
        effectiveModel: result.data?.effectiveModel || DEFAULT_AUDIO_MODEL,
        overrideModel: result.data?.overrideModel || '',
        source: result.data?.source || 'default',
      });
    } catch {
      setAudioRuntimeState(null);
    }
  }, []);

  const fetchImageModels = useCallback(async () => {
    try {
      setIsRefreshingImage(true);
      const response = await fetchBotApi('/api/models/openrouter/image');
      if (response.ok) {
        const result = await response.json();
        const allModels = result.data?.all || [];
        if (allModels.length > 0) {
          setImageModels(allModels);
        }
      } else {
        const message = `Ошибка ${response.status}: не удалось загрузить image модели`;
        setRefreshMessage(message);
        setTimeout(() => setRefreshMessage(''), 5000);
        throw new Error(message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось загрузить image модели';
      setRefreshMessage(message);
      setTimeout(() => setRefreshMessage(''), 5000);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setIsRefreshingImage(false);
    }
  }, []);

  useEffect(() => {
    fetchVisionModels(false);
  }, [fetchVisionModels]);

  useEffect(() => {
    fetchAudioState();
  }, [fetchAudioState]);

  useEffect(() => {
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    void fetchImageModels().catch(() => {
      retryTimeout = setTimeout(() => {
        void fetchImageModels().catch(() => undefined);
      }, 3000);
    });

    return () => {
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [fetchImageModels]);

  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    retry: 1,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['settings-runtime-truth'] });
      void fetchVisionModels(false);
      void fetchAudioState();
      setSaveMessage('Настройки сохранены!');
      setTimeout(() => setSaveMessage(''), 3000);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('timeout')) {
        setSaveMessage('⚠️ Возможно сохранено (ответ не получен). Обновите страницу.');
      } else {
        setSaveMessage(`Ошибка: ${msg.slice(0, 100)}`);
      }
      setTimeout(() => setSaveMessage(''), 5000);
    },
  });

  const form = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      tts_enabled: true,
      audio_model: DEFAULT_AUDIO_MODEL,
      vision_model: DEFAULT_VISION_MODEL,
      vision_prompt: DEFAULT_VISION_PROMPT,
      vision_max_tokens: DEFAULT_VISION_MAX_TOKENS,
      openrouter_image_model: 'google/gemini-2.5-flash-image',
      tts_provider: 'edge',
      elevenlabs_api_key: '',
      elevenlabs_voice_id: '21m00Tcm4TlvDq8ikWAM',
      elevenlabs_custom_voice_id: '',
      elevenlabs_model_id: 'eleven_multilingual_v2',
      openai_tts_voice: 'nova',
      openai_tts_model: 'tts-1-hd',
      voice_speaker: 'svetlana',
      openai_api_key: '',
    },
  });

  const testVisionModel = async (modelId: string) => {
    setTestingModel(modelId);
    try {
      const resp = await fetchBotApi('/api/models/vision/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      const json = await resp.json();
      setModelTestResults(prev => ({
        ...prev,
        [modelId]: {
          status: json.status === 'ok' ? 'ok' : 'error',
          latencyMs: json.latencyMs || 0,
          detail: json.detail,
          error: json.error,
        },
      }));
    } catch {
      setModelTestResults(prev => ({
        ...prev,
        [modelId]: { status: 'error', latencyMs: 0, error: 'Сетевая ошибка' },
      }));
    } finally {
      setTestingModel(null);
    }
  };

  useEffect(() => {
    if (settings) {
      const map = settings.reduce(
        (acc: Record<string, string>, s: { key: string; value: string }) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );
      form.reset(mapSettingsToFormValues(map));
    }
  }, [settings, form.reset]);

  const onSubmit = (data: SettingsForm) => {
    const visionTest = modelTestResults[data.vision_model];
    if (visionTest?.status === 'error') {
      const ok = confirm(`⚠️ Vision модель "${data.vision_model}" не прошла тест: ${visionTest.error || 'ошибка'}.\n\nВсё равно сохранить?`);
      if (!ok) return;
    }

    const toSave: Record<string, string> = {
      audio_model: data.audio_model,
      tts_enabled: data.tts_enabled ? 'true' : 'false',
      preferred_vision_model: data.vision_model,
      vision_prompt: data.vision_prompt,
      vision_max_tokens: String(data.vision_max_tokens),
      openrouter_image_model: data.openrouter_image_model || 'google/gemini-2.5-flash-image',
      tts_provider: data.tts_provider,
      elevenlabs_voice_id: data.elevenlabs_voice_id === 'custom'
        ? (data.elevenlabs_custom_voice_id || '21m00Tcm4TlvDq8ikWAM')
        : (data.elevenlabs_voice_id || '21m00Tcm4TlvDq8ikWAM'),
      elevenlabs_model_id: data.elevenlabs_model_id || 'eleven_multilingual_v2',
      openai_tts_voice: data.openai_tts_voice,
      openai_tts_model: data.openai_tts_model,
      voice_speaker: data.voice_speaker,
    };
    if (data.elevenlabs_api_key) {
      toSave.elevenlabs_api_key = data.elevenlabs_api_key;
    }
    if (data.openai_api_key) {
      toSave.openai_api_key = data.openai_api_key;
    }
    saveSettings(toSave);
  };

  const resetForm = () => {
    if (settings) {
      const map = settings.reduce(
        (acc: Record<string, string>, s: { key: string; value: string }) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );
      form.reset(mapSettingsToFormValues(map));
    }
  };

  return {
    form,
    isLoading,
    isSaving,
    saveMessage,
    runtimeTruth,
    visionModels,
    imageModels,
    isRefreshingVision,
    isRefreshingImage,
    refreshMessage,
    audioRuntimeState,
    testingModel,
    modelTestResults,
    fetchVisionModels,
    fetchImageModels,
    testVisionModel,
    onSubmit,
    resetForm,
  };
}
