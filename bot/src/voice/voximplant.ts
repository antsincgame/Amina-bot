import crypto from 'crypto';
import { config } from '../config/index.js';
import { voiceLogger } from '../config/logger.js';

// --------------------------------------------
// Voximplant API Client
// --------------------------------------------

const VOXIMPLANT_API_URL = 'https://api.voximplant.com/platform_api';

interface VoximplantConfig {
  accountId: string;
  apiKey: string;
  applicationId: string;
  applicationName: string;
}

// Active calls storage
const activeCalls = new Map<string, VoximplantCallState>();

export interface VoximplantCallState {
  call_id: string;
  status: 'ringing' | 'connected' | 'ended';
  direction: 'inbound' | 'outbound';
  caller_id: string;
  called_number: string;
  started_at: string;
  answered_at?: string;
  ended_at?: string;
  duration_ms?: number;
}

export interface VoximplantWebhookEvent {
  event: string;
  call_session_id: string;
  caller_id?: string;
  destination?: string;
  start_time?: string;
  duration?: number;
  recording_url?: string;
  transcription?: string;
  custom_data?: Record<string, unknown>;
}

// --------------------------------------------
// API Authentication
// --------------------------------------------

const getVoximplantConfig = (): VoximplantConfig => {
  const accountId = process.env['VOXIMPLANT_ACCOUNT_ID'];
  const apiKey = process.env['VOXIMPLANT_API_KEY'];
  const applicationId = process.env['VOXIMPLANT_APP_ID'];
  const applicationName = process.env['VOXIMPLANT_APP_NAME'];

  if (!accountId || !apiKey) {
    throw new Error('Voximplant credentials not configured');
  }

  return {
    accountId,
    apiKey,
    applicationId: applicationId ?? '',
    applicationName: applicationName ?? 'amina-bot',
  };
};

const makeApiRequest = async <T>(
  method: string,
  params: Record<string, string | number> = {}
): Promise<T> => {
  const voxConfig = getVoximplantConfig();

  const allParams = {
    account_id: voxConfig.accountId,
    api_key: voxConfig.apiKey,
    ...params,
  };

  const queryString = new URLSearchParams(
    Object.entries(allParams).map(([k, v]) => [k, String(v)])
  ).toString();

  const url = `${VOXIMPLANT_API_URL}/${method}?${queryString}`;

  voiceLogger.debug({ method }, 'Voximplant API request');

  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    voiceLogger.error({ method, status: response.status, error }, 'Voximplant API error');
    throw new Error(`Voximplant API error: ${response.status}`);
  }

  const data = await response.json() as T;
  return data;
};

// --------------------------------------------
// Webhook Handler
// --------------------------------------------

export const handleVoximplantWebhook = async (
  event: VoximplantWebhookEvent
): Promise<{ response?: string; data?: unknown }> => {
  voiceLogger.info(
    { event: event.event, callId: event.call_session_id },
    'Voximplant webhook received'
  );

  switch (event.event) {
    case 'call.started':
      return handleCallStarted(event);

    case 'call.connected':
      return handleCallConnected(event);

    case 'call.ended':
      return handleCallEnded(event);

    case 'call.transcription':
      return handleTranscription(event);

    case 'call.recording':
      return handleRecording(event);

    default:
      voiceLogger.debug({ event: event.event }, 'Unhandled Voximplant event');
      return {};
  }
};

// --------------------------------------------
// Call Event Handlers
// --------------------------------------------

const handleCallStarted = async (
  event: VoximplantWebhookEvent
): Promise<{ response?: string }> => {
  const callState: VoximplantCallState = {
    call_id: event.call_session_id,
    status: 'ringing',
    direction: 'inbound',
    caller_id: event.caller_id ?? 'unknown',
    called_number: event.destination ?? '',
    started_at: event.start_time ?? new Date().toISOString(),
  };

  activeCalls.set(event.call_session_id, callState);

  voiceLogger.info(
    { callId: event.call_session_id, from: event.caller_id },
    'Incoming call started'
  );

  return {
    response: 'Здравствуйте! Вас приветствует AI-ассистент Amina.',
  };
};

const handleCallConnected = async (
  event: VoximplantWebhookEvent
): Promise<{ response?: string }> => {
  const callState = activeCalls.get(event.call_session_id);

  if (callState) {
    callState.status = 'connected';
    callState.answered_at = new Date().toISOString();
    activeCalls.set(event.call_session_id, callState);
  }

  voiceLogger.info({ callId: event.call_session_id }, 'Call connected');

  return {};
};

const handleCallEnded = async (
  event: VoximplantWebhookEvent
): Promise<{ response?: string }> => {
  const callState = activeCalls.get(event.call_session_id);

  if (callState) {
    callState.status = 'ended';
    callState.ended_at = new Date().toISOString();
    callState.duration_ms = event.duration ? event.duration * 1000 : 0;

    voiceLogger.info(
      { callId: event.call_session_id, duration: callState.duration_ms },
      'Call ended'
    );

    // Remove from active calls after a delay
    setTimeout(() => {
      activeCalls.delete(event.call_session_id);
    }, 60000);
  }

  return {};
};

const handleTranscription = async (
  event: VoximplantWebhookEvent
): Promise<{ response?: string }> => {
  if (event.transcription) {
    voiceLogger.info(
      { callId: event.call_session_id, text: event.transcription.substring(0, 100) },
      'Transcription received'
    );

    try {
      // Import AI service
      const { aiService } = await import('../ai/openrouter.js');
      
      // Get conversation history for this call
      const callState = activeCalls.get(event.call_session_id);
      const history: { role: 'user' | 'assistant'; content: string }[] = [];
      
      // Add user message
      history.push({ role: 'user', content: event.transcription });
      
      // Get AI response
      const aiResponse = await aiService.chat(history, 'voice');
      
      voiceLogger.info(
        { callId: event.call_session_id, responseLength: aiResponse.content.length },
        'AI response generated'
      );
      
      return {
        response: aiResponse.content,
      };
    } catch (error) {
      voiceLogger.error({ error }, 'Failed to get AI response');
      return {
        response: 'Извините, произошла ошибка. Попробуйте ещё раз.',
      };
    }
  }

  return {};
};

const handleRecording = async (
  event: VoximplantWebhookEvent
): Promise<{ response?: string }> => {
  if (event.recording_url) {
    voiceLogger.info(
      { callId: event.call_session_id, recordingUrl: event.recording_url },
      'Recording available'
    );
  }

  return {};
};

// --------------------------------------------
// Outbound Calls
// --------------------------------------------

export const makeOutboundCall = async (
  phoneNumber: string,
  customData?: Record<string, unknown>
): Promise<{ call_session_id: string }> => {
  const voxConfig = getVoximplantConfig();

  voiceLogger.info({ to: phoneNumber }, 'Initiating outbound call');

  return makeApiRequest<{ call_session_id: string }>('StartScenarios', {
    rule_id: voxConfig.applicationId,
    script_custom_data: JSON.stringify({
      destination: phoneNumber,
      ...customData,
    }),
  });
};

// --------------------------------------------
// Call Management
// --------------------------------------------

export const getCallStatus = (callId: string): VoximplantCallState | undefined => {
  return activeCalls.get(callId);
};

export const getActiveCalls = (): VoximplantCallState[] => {
  return Array.from(activeCalls.values());
};

// --------------------------------------------
// Account Info
// --------------------------------------------

export const getAccountInfo = async (): Promise<{
  account_name: string;
  balance: number;
  currency: string;
}> => {
  return makeApiRequest<{
    account_name: string;
    balance: number;
    currency: string;
  }>('GetAccountInfo');
};

export const getPhoneNumbers = async (): Promise<{
  phone_numbers: { phone_number: string; phone_region_name: string }[];
}> => {
  return makeApiRequest<{
    phone_numbers: { phone_number: string; phone_region_name: string }[];
  }>('GetPhoneNumbers');
};

// --------------------------------------------
// Webhook Verification
// --------------------------------------------

export const verifyWebhookSignature = (
  body: string,
  signature: string,
  secret: string
): boolean => {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
};

// --------------------------------------------
// Health Check
// --------------------------------------------

export const isVoximplantEnabled = (): boolean => {
  try {
    getVoximplantConfig();
    return true;
  } catch {
    return false;
  }
};

export const testVoximplantConnection = async (): Promise<boolean> => {
  if (!isVoximplantEnabled()) {
    return false;
  }

  try {
    await getAccountInfo();
    return true;
  } catch {
    return false;
  }
};

// --------------------------------------------
// VoxEngine Scenario (JavaScript для Voximplant)
// --------------------------------------------

/**
 * Пример сценария VoxEngine для обработки звонков с AI.
 * Этот код загружается в Voximplant Console.
 * 
 * @example
 * ```javascript
 * // VoxEngine Scenario: AI Assistant
 * 
 * require(Modules.ASR);
 * require(Modules.Player);
 * 
 * const BOT_WEBHOOK_URL = 'https://your-render-app.onrender.com/webhook/voximplant';
 * 
 * VoxEngine.addEventListener(AppEvents.CallAlerting, async (e) => {
 *   const call = e.call;
 *   call.answer();
 *   
 *   // Приветствие
 *   await call.say('Здравствуйте! Вас приветствует AI-ассистент Amina.', Language.RU_RUSSIAN_FEMALE);
 *   
 *   // Включить распознавание речи
 *   call.addEventListener(CallEvents.RecordStarted, () => {
 *     Logger.write('Recording started');
 *   });
 *   
 *   // При получении речи - отправить на webhook
 *   call.addEventListener(CallEvents.PlaybackFinished, async () => {
 *     // Слушаем пользователя
 *     const asr = VoxEngine.createASR({
 *       profile: ASRProfileList.Google.ru_RU
 *     });
 *     
 *     asr.addEventListener(ASREvents.Result, async (asrEvent) => {
 *       const userText = asrEvent.text;
 *       
 *       // Отправляем на бэкенд
 *       const response = await Net.httpRequest(BOT_WEBHOOK_URL, {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json' },
 *         postData: JSON.stringify({
 *           event: 'call.transcription',
 *           call_session_id: call.id(),
 *           transcription: userText
 *         })
 *       });
 *       
 *       const data = JSON.parse(response.text);
 *       if (data.response) {
 *         await call.say(data.response, Language.RU_RUSSIAN_FEMALE);
 *       }
 *     });
 *     
 *     call.sendMediaTo(asr);
 *   });
 * });
 * ```
 */
export const VOXENGINE_SCENARIO_EXAMPLE = `
// Скопируйте этот код в Voximplant Console → Applications → Scenarios
// Документация: https://voximplant.com/docs/guides/voxengine

require(Modules.ASR);
require(Modules.Player);

const BOT_WEBHOOK_URL = 'https://your-app.onrender.com/webhook/voximplant';

VoxEngine.addEventListener(AppEvents.CallAlerting, async (e) => {
  const call = e.call;
  call.answer();
  
  // Greeting
  await call.say('Здравствуйте! Чем могу помочь?', Language.RU_RUSSIAN_FEMALE);
  
  // ASR setup
  const asr = VoxEngine.createASR({ profile: ASRProfileList.Google.ru_RU });
  
  asr.addEventListener(ASREvents.Result, async (asrEvent) => {
    const response = await Net.httpRequest(BOT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      postData: JSON.stringify({
        event: 'call.transcription',
        call_session_id: call.id(),
        transcription: asrEvent.text
      })
    });
    
    const data = JSON.parse(response.text);
    if (data.response) {
      await call.say(data.response, Language.RU_RUSSIAN_FEMALE);
    }
  });
  
  call.sendMediaTo(asr);
});
`;
