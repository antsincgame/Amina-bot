/**
 * ПРОСТОЙ VoxEngine Scenario для Amina
 * 
 * Копируйте этот код в Voximplant Console → Scenarios
 */

// ⚠️ ЗАМЕНИТЕ НА URL ВАШЕГО БОТА (после деплоя на Render)
var BOT_URL = "https://amina-bot.onrender.com/webhook/voximplant";

require(Modules.ASR);

var call;

// Входящий звонок
VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
    call = e.call;
    call.answer();
    call.addEventListener(CallEvents.Connected, handleConnected);
    call.addEventListener(CallEvents.Disconnected, VoxEngine.terminate);
});

// Звонок принят
function handleConnected() {
    // Приветствие
    call.say("Здравствуйте! Я Амина. Чем могу помочь?", Language.RU_RUSSIAN_FEMALE);
    call.addEventListener(CallEvents.PlaybackFinished, startASR);
}

// Начинаем слушать
function startASR() {
    var asr = VoxEngine.createASR({
        profile: ASRProfileList.Google.ru_RU
    });
    
    asr.addEventListener(ASREvents.Result, function(e) {
        Logger.write("User: " + e.text);
        getAIResponse(e.text);
    });
    
    call.sendMediaTo(asr);
}

// Получаем ответ от AI
function getAIResponse(userText) {
    var data = JSON.stringify({
        event: "call.transcription",
        call_session_id: call.id(),
        transcription: userText
    });
    
    Net.httpRequestAsync(BOT_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        postData: data
    }).then(function(res) {
        try {
            var json = JSON.parse(res.text);
            var answer = json.response || "Извините, не понял.";
            Logger.write("AI: " + answer);
            call.say(answer, Language.RU_RUSSIAN_FEMALE);
            call.addEventListener(CallEvents.PlaybackFinished, startASR);
        } catch(err) {
            call.say("Ошибка обработки.", Language.RU_RUSSIAN_FEMALE);
        }
    });
}
