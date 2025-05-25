document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const startVoiceButton = document.getElementById('startVoice');
    const stopVoiceButton = document.getElementById('stopVoice');
    const listCommandsButton = document.getElementById('listCommands');
    const voiceStatus = document.getElementById('voiceStatus');
    const voiceTranscript = document.getElementById('voiceTranscript');
    const assistantOutputDiv = document.getElementById('assistantOutput');
    const checkContrastButton = document.getElementById('checkContrast');
    const fixContrastButton = document.getElementById('fixContrastIssues');
    const readSelectedButton = document.getElementById('readSelected');
    const imageDescriptionDisplay = document.getElementById('imageDescription');
    const hfApiKeyInput = document.getElementById('hfApiKey');
    const saveApiKeyButton = document.getElementById('saveApiKey');
    const apiKeyStatus = document.getElementById('apiKeyStatus');

    let recognition;
    let isListening = false;
    let lastFoundContrastIssues = []; // Store issues to try and fix them

    const AVAILABLE_COMMANDS = [
        "read selected text",
        "check contrast",
        "fix contrast", // New
        "scroll down / scroll the page down / scroll through the page",
        "scroll up / scroll the page up",
        "scroll to top / go to top",
        "scroll to bottom / go to bottom",
        "click link [text of link]",
        "click button [text of button]",
        "list available commands / what can you do"
    ];

    // Load saved API key
    chrome.storage.local.get(['hfApiKey'], function(result) {
        if (result.hfApiKey) hfApiKeyInput.value = result.hfApiKey;
    });

    saveApiKeyButton.addEventListener('click', () => {
        const key = hfApiKeyInput.value.trim();
        if (key) {
            sendMessageToBackground({ type: "UPDATE_API_KEY", payload: { apiKey: key } }, (response) => {
                if (response && response.success) {
                    apiKeyStatus.textContent = response.message;
                    speakAndDisplay(response.message);
                } else {
                    apiKeyStatus.textContent = (response && response.message) || "Failed to save key.";
                    speakAndDisplay((response && response.message) || "Failed to save API key.");
                }
                setTimeout(() => apiKeyStatus.textContent = "", 3000);
            });
        } else {
            apiKeyStatus.textContent = "API Key cannot be empty.";
            speakAndDisplay("API Key cannot be empty.");
        }
    });

    // --- Voice Recognition Setup ---
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            isListening = true;
            voiceStatus.textContent = 'Status: Listening...';
            startVoiceButton.disabled = true;
            stopVoiceButton.disabled = false;
            voiceTranscript.textContent = "";
            console.log("Voice recognition started.");
        };

        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript.trim();
            voiceTranscript.textContent = transcript;
            console.log("Voice recognized:", transcript);
            processVoiceCommand(transcript);
        };

        recognition.onerror = (event) => {
            let errorMessage = `Voice Error: ${event.error}`;
            if (event.error === 'no-speech') errorMessage = 'No speech detected.';
            else if (event.error === 'audio-capture') errorMessage = 'Mic problem. Check permissions/hardware.';
            else if (event.error === 'not-allowed') errorMessage = 'Mic access denied. Please allow it.';
            voiceStatus.textContent = errorMessage;
            console.error("Speech recognition error:", event);
            speakAndDisplay(errorMessage);
            isListening = false;
            startVoiceButton.disabled = false;
            stopVoiceButton.disabled = true;
        };

        recognition.onend = () => {
            isListening = false;
            if (voiceStatus.textContent.includes("Listening")) { // Only reset if it wasn't an error
                 voiceStatus.textContent = 'Status: Idle. Click "Start Listening".';
            }
            startVoiceButton.disabled = false;
            stopVoiceButton.disabled = true;
            console.log("Voice recognition ended.");
        };

        startVoiceButton.addEventListener('click', () => {
            if (!isListening) {
                try {
                    voiceTranscript.textContent = "";
                    // assistantOutputDiv.textContent = ""; // Don't clear assistant output on new listen
                    recognition.start();
                } catch (e) {
                    console.error("Error starting recognition:", e);
                    voiceStatus.textContent = "Error starting recognition.";
                    speakAndDisplay("Error starting voice recognition.");
                }
            }
        });

        stopVoiceButton.addEventListener('click', () => { if (isListening) recognition.stop(); });
        listCommandsButton.addEventListener('click', () => listAvailableCommands());

    } else {
        voiceStatus.textContent = 'Voice recognition not supported.';
        startVoiceButton.disabled = true;
        stopVoiceButton.disabled = true;
        listCommandsButton.disabled = true;
    }

    function processVoiceCommand(commandRaw) {
        const command = commandRaw.toLowerCase();
        speakAndDisplay(`You said: ${commandRaw}`);

        if (command.includes("list available commands") || command.includes("what can you do") || command.includes("help")) {
            listAvailableCommands();
        } else if (command.startsWith("click link")) {
            const textToFind = command.replace("click link", "").trim();
            if (textToFind) clickPageElement("link", textToFind); else speakAndDisplay("Please specify link text.");
        } else if (command.startsWith("click button")) {
            const textToFind = command.replace("click button", "").trim();
            if (textToFind) clickPageElement("button", textToFind); else speakAndDisplay("Please specify button text.");
        } else if (command.includes("read selected text") || command.includes("read selection")) {
            readSelectedText();
        } else if (command.includes("check contrast") || command.includes("analyze contrast")) {
            checkPageContrast();
        } else if (command.includes("fix contrast")) { // NEW
            attemptToFixContrast();
        } else if (command.includes("describe image")) {
            speakAndDisplay("To describe an image, right-click it and choose 'Describe Image'.");
        } else if (command.includes("scroll down") || command.includes("scroll the page down") || command.includes("scroll through the page")) {
            scrollPageOnTab("down");
        } else if (command.includes("scroll up") || command.includes("scroll the page up")) {
            scrollPageOnTab("up");
        } else if (command.includes("scroll to top") || command.includes("go to top")) {
            scrollPageOnTab("top");
        } else if (command.includes("scroll to bottom") || command.includes("go to bottom")) {
            scrollPageOnTab("bottom");
        } else {
            speakAndDisplay("Sorry, I didn't understand that command. Say 'list available commands' for help.");
        }
    }
    
    function listAvailableCommands() {
        const commandsText = "Available voice commands are: " + AVAILABLE_COMMANDS.join(", ");
        speakAndDisplay(commandsText);
    }

    function clickPageElement(elementType, textToFind) {
        sendMessageToContentScript({ type: "CLICK_ELEMENT", payload: { elementType, text: textToFind }});
        speakAndDisplay(`Attempting to click ${elementType} with text "${textToFind}"`);
    }

    function scrollPageOnTab(direction) {
        sendMessageToContentScript({ type: "SCROLL_PAGE", payload: { direction } });
        speakAndDisplay(`Scrolling ${direction}.`);
    }

    // --- Accessibility Check Buttons ---
    checkContrastButton.addEventListener('click', checkPageContrast);
    fixContrastButton.addEventListener('click', attemptToFixContrast);
    readSelectedButton.addEventListener('click', readSelectedText);

    function checkPageContrast() {
        fixContrastButton.style.display = 'none'; // Hide fix button until new issues are found
        lastFoundContrastIssues = [];
        speakAndDisplay("Checking page for contrast issues...");
        sendMessageToContentScript({ type: "GET_CONTRAST_ISSUES" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error checking contrast:", chrome.runtime.lastError.message);
                speakAndDisplay(`Error communicating with the page: ${chrome.runtime.lastError.message}. Try on a different page or reload the extension.`);
                return;
            }
            if (response && response.payload && response.payload.issues) {
                lastFoundContrastIssues = response.payload.issues;
                if (lastFoundContrastIssues.length > 0) {
                    let report = `Found ${lastFoundContrastIssues.length} contrast issues. First issue: Text "${lastFoundContrastIssues[0].text.substring(0, 20)}..." (Ratio: ${lastFoundContrastIssues[0].ratio}). Say 'fix contrast' or click the button to attempt a fix.`;
                    speakAndDisplay(report);
                    fixContrastButton.style.display = 'inline-block'; // Show fix button
                    console.log("Contrast Issues Found:", lastFoundContrastIssues);
                } else {
                    speakAndDisplay("No major contrast issues found with this basic check.");
                }
            } else {
                speakAndDisplay("Could not check contrast or no valid response from page. Ensure you are on a standard webpage.");
            }
        });
    }

    function attemptToFixContrast() {
        if (lastFoundContrastIssues.length > 0) {
            speakAndDisplay("Attempting to fix contrast issues on the page...");
            sendMessageToContentScript({ type: "FIX_CONTRAST_ISSUES", payload: { issuesToFix: lastFoundContrastIssues } }, (response) => {
                 if (chrome.runtime.lastError) {
                    console.error("Error fixing contrast:", chrome.runtime.lastError.message);
                    speakAndDisplay(`Error sending fix command: ${chrome.runtime.lastError.message}`);
                    return;
                }
                if (response && response.payload && response.payload.fixedCount !== undefined) {
                    speakAndDisplay(`Attempted to fix ${response.payload.fixedCount} contrast issues. Some changes might be subtle or not fully effective.`);
                    fixContrastButton.style.display = 'none'; // Hide after attempting
                } else {
                    speakAndDisplay("Could not apply contrast fixes or no response from page.");
                }
            });
        } else {
            speakAndDisplay("No contrast issues were previously identified to fix. Please run 'check contrast' first.");
        }
    }
    
    function readSelectedText() {
        sendMessageToContentScript({ type: "GET_SELECTED_TEXT" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error getting selected text:", chrome.runtime.lastError.message);
                speakAndDisplay(`Error getting selected text: ${chrome.runtime.lastError.message}`);
                return;
            }
            if (response && response.payload && response.payload.text && response.payload.text.trim() !== "") {
                speakAndDisplay(response.payload.text); // Let speakAndDisplay also use background TTS
            } else {
                speakAndDisplay("No text selected, or couldn't retrieve selected text.");
            }
        });
    }

    // --- Listen for messages from background script (e.g., image description) ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "IMAGE_DESCRIPTION_RESULT") {
            const { text, isError, isLoading } = message.payload;
            if (isLoading) {
                imageDescriptionDisplay.textContent = "Loading description...";
                imageDescriptionDisplay.classList.remove('error-text');
            } else {
                imageDescriptionDisplay.textContent = text;
                if (isError) {
                    imageDescriptionDisplay.classList.add('error-text'); // Add a class for error styling
                } else {
                    imageDescriptionDisplay.classList.remove('error-text');
                }
            }
            // The background script speaks this, but we also display it in the assistant output.
            // No, let's only display this in the dedicated imageDescriptionDisplay.
            // speakAndDisplay(text); // Avoid double speaking. Background script already speaks for context menu.
        }
        // No need to return true here as popup is just receiving.
    });

    // --- Helper to send messages to content script ---
    function sendMessageToContentScript(message, callback) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs.length > 0 && tabs[0].id) {
                chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error(`Error sending message to content script (type: ${message.type}):`, chrome.runtime.lastError.message);
                        if (callback) callback({ error: chrome.runtime.lastError.message });
                        return;
                    }
                    if (callback) callback(response);
                });
            } else {
                const noTabError = "No active tab found to send message.";
                console.error(noTabError);
                speakAndDisplay(noTabError + " Please ensure a webpage is active.");
                if (callback) callback({ error: noTabError });
            }
        });
    }

    // --- Unified helper to speak text AND display it in assistant's output box ---
    function speakAndDisplay(text) {
        if (typeof text !== 'string') {
            console.warn("speakAndDisplay called with non-string:", text);
            text = String(text); // Attempt to convert to string
        }
        
        console.log("Assistant output:", text); // Log what's being displayed/spoken
        if (assistantOutputDiv) {
            assistantOutputDiv.textContent = text;
            assistantOutputDiv.scrollTop = assistantOutputDiv.scrollHeight; // Auto-scroll
        } else {
            console.warn("Assistant output div not found in popup.js");
        }
        // Send to background for TTS
        sendMessageToBackground({ type: "SPEAK_TEXT", payload: { text: text } });
    }

    // Helper to send messages to background script
    function sendMessageToBackground(message, callback) {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                console.error(`Error sending message to background (type: ${message.type}):`, chrome.runtime.lastError.message);
                // Optionally handle this error, e.g., by displaying it in the popup
            }
            if (callback) {
                callback(response);
            }
        });
    }
});

// Add a CSS class for error text styling in popup.css if you like:
// .error-text { color: red; font-weight: bold; }