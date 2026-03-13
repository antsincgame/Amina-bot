export type TelephonyAiScenarioMode = 'speech' | 'ask_question';

export type TelephonyAiSessionStatus =
  | 'initiated'
  | 'linked'
  | 'recorded'
  | 'processed'
  | 'failed';

export interface TelephonyAiScenario {
  id: string;
  name: string;
  enabled: boolean;
  callMode: TelephonyAiScenarioMode;
  goal: string;
  systemPrompt: string;
  openingLine: string;
  questionHint: string;
  successCriteria: string;
  resultPrompt: string;
  maxSpeechChars: number;
  createdAt: string;
  updatedAt: string;
}

export interface TelephonyAiCallPlan {
  summary: string;
  callMode: TelephonyAiScenarioMode;
  speechText: string | null;
  helloText: string | null;
  askText: string | null;
  okText: string | null;
  byeText: string | null;
  successHint: string | null;
}

export interface TelephonyAiCallSession {
  id: string;
  ownerTelegramId: string;
  initiatedBy: string;
  scenarioId: string;
  scenarioName: string;
  scenarioGoal: string;
  callMode: TelephonyAiScenarioMode;
  targetPhone: string;
  task: string;
  summary: string;
  successCriteria: string;
  resultPrompt: string;
  requestId: string | null;
  requestMode: string;
  callId: string | null;
  recordLink: string | null;
  transcript: string | null;
  resultSummary: string | null;
  outcomeLabel: string | null;
  status: TelephonyAiSessionStatus;
  createdAt: string;
  updatedAt: string;
}
