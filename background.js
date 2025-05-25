let HUGGING_FACE_API_KEY = null;

// Load API key from storage when the extension starts
chrome.storage.local.get(['hfApiKey'], function(result) {
    if (result.hfApiKey) {
        HUGGING_FACE_API_KEY = result.hfApiKey;
        console.log("AuraLense BG: Hugging Face API Key loaded from storage.");
    } else {
        console.warn("AuraLense BG: Hugging Face API Key not set in storage. Please set it in the popup.");
    }
});

// Create context menu item for image description
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "describeImageAuraLense",
        title: "Describe Image with AuraLense",
        contexts: ["image"]
    });
    console.log("AuraLense BG: Context menu created/updated.");
});

// Handle context menu click for image description
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "describeImageAuraLense" && info.srcUrl) {
        if (!HUGGING_FACE_API_KEY) {
            const noApiKeyMsg = "Hugging Face API Key not set. Please set it in the extension popup.";
            console.error("AuraLense BG (Image Description):", noApiKeyMsg);
            chrome.runtime.sendMessage({ type: "IMAGE_DESCRIPTION_RESULT", payload: { text: noApiKeyMsg, isError: true } });
            speakContextMenuMessage("Error: Hugging Face API Key is not set.");
            return;
        }

        if (info.srcUrl.startsWith('data:image')) {
            const base64ErrorMsg = "This image is embedded (base64) and cannot be described by URL with this model. Try a publicly hosted image.";
            console.warn("AuraLense BG (Image Description):", base64ErrorMsg);
            chrome.runtime.sendMessage({ type: "IMAGE_DESCRIPTION_RESULT", payload: { text: base64ErrorMsg, isError: true } });
            speakContextMenuMessage(base64ErrorMsg);
            return;
        }
        if (!info.srcUrl.startsWith('http:') && !info.srcUrl.startsWith('https:')) {
            const invalidUrlMsg = "Invalid image URL. Only http or https URLs can be processed for description.";
            console.warn("AuraLense BG (Image Description): Invalid URL -", info.srcUrl);
            chrome.runtime.sendMessage({ type: "IMAGE_DESCRIPTION_RESULT", payload: { text: invalidUrlMsg, isError: true } });
            speakContextMenuMessage(invalidUrlMsg);
            return;
        }

        chrome.runtime.sendMessage({ type: "IMAGE_DESCRIPTION_RESULT", payload: { text: "Describing image, please wait...", isLoading: true } });
        speakContextMenuMessage("Describing image, please wait.");

        try {
            const requestBody = JSON.stringify({ inputs: info.srcUrl });
            const response = await fetch(
                "https://api-inference.huggingface.co/models/nlpconnect/vit-gpt2-image-captioning",
                {
                    headers: {
                        "Authorization": `Bearer ${HUGGING_FACE_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    method: "POST",
                    // body: requestBody // This was a common mistake, it should be 'body: requestBody' not 'body: { inputs: info.srcUrl }' if requestBody is already stringified JSON
                }
            );
             // Corrected body for fetch:
             // const response = await fetch(
             // "https://api-inference.huggingface.co/models/nlpconnect/vit-gpt2-image-captioning",
             // {
             //     headers: {
             //         "Authorization": `Bearer ${HUGGING_FACE_API_KEY}`,
             //         "Content-Type": "application/json"
             //     },
             //     method: "POST",
             //     body: JSON.stringify({ inputs: info.srcUrl }) // Directly stringify here
             // }
            // );
            // Re-checking: the `requestBody` was already defined correctly. The fetch call itself had `body: requestBody` which is correct.
            // My comment above was a bit misleading, the original way was fine.

            if (!response.ok) {
                let errorData;
                const contentType = response.headers.get("content-type");
                if (contentType && contentType.includes("application/json")) {
                    errorData = await response.json();
                } else {
                    errorData = { error: await response.text() || `HTTP error ${response.status}` };
                }
                
                console.error("AuraLense BG: Hugging Face API Error:", response.status, errorData);
                let errorMessage = `API Error ${response.status}: ${errorData.error || "Failed to describe image."}`;

                if (response.status === 401) {
                    errorMessage = "Error: Invalid or missing Hugging Face API Key.";
                } else if (response.status === 404) { // Specific 404 handling
                    errorMessage = "Error 404: The image URL was not found. Please check the link.";
                } else if (response.status === 503 && errorData.error && String(errorData.error).toLowerCase().includes("model") && String(errorData.error).toLowerCase().includes("currently loading")) {
                    errorMessage = "Model is loading on the server. Please try again shortly.";
                    if (errorData.estimated_time) errorMessage += ` Est. wait: ${Math.ceil(errorData.estimated_time)}s.`;
                } else if (response.status === 503) {
                    errorMessage = "Service unavailable (model might be overloaded). Try again later.";
                } else if (errorData.error && (String(errorData.error).toLowerCase().includes("is not a valid image url") || String(errorData.error).toLowerCase().includes("could not download image")) ) {
                    errorMessage = "The image URL could not be processed. Ensure it's a public, direct link to an image.";
                }

                chrome.runtime.sendMessage({ type: "IMAGE_DESCRIPTION_RESULT", payload: { text: errorMessage, isError: true } });
                speakContextMenuMessage(errorMessage);
                return;
            }

            const result = await response.json();
            console.log("AuraLense BG: HF API Result:", result);
            let description = "No description generated or unknown API format.";
            if (result && Array.isArray(result) && result.length > 0 && result[0].generated_text) {
                description = result[0].generated_text;
            } else if (result && result.generated_text) {
                 description = result.generated_text;
            } else if (typeof result === 'string' && result.trim() !== "") {
                description = result;
            }

            chrome.runtime.sendMessage({ type: "IMAGE_DESCRIPTION_RESULT", payload: { text: description, isError: false } });
            speakContextMenuMessage(`Image description: ${description}`);

        } catch (error) {
            console.error("AuraLense BG: Error describing image (Network/JS):", error);
            let networkErrorMsg = "Network error or API issue. Check internet and background console.";
            if (error.name === 'AbortError') networkErrorMsg = "Request aborted (timeout).";
            else if (error.message && error.message.toLowerCase().includes('failed to fetch')) networkErrorMsg = "Failed to connect to API. Check internet.";
            
            chrome.runtime.sendMessage({ type: "IMAGE_DESCRIPTION_RESULT", payload: { text: networkErrorMsg, isError: true } });
            speakContextMenuMessage(networkErrorMsg);
        }
    }
});

function speakContextMenuMessage(text) {
    if (typeof text === 'string' && text.trim() !== "") {
        chrome.tts.speak(text, { 'rate': 1.0, onEvent: function(event) { if (event.type === 'error') console.error('AuraLense BG: TTS Error:', event.errorMessage);}});
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "UPDATE_API_KEY") {
        if (message.payload && typeof message.payload.apiKey === 'string') {
            HUGGING_FACE_API_KEY = message.payload.apiKey.trim();
            chrome.storage.local.set({ hfApiKey: HUGGING_FACE_API_KEY }, () => {
                if (chrome.runtime.lastError) {
                    console.error("AuraLense BG: Error saving API key:", chrome.runtime.lastError);
                    sendResponse({ success: false, message: "Failed to save API key." });
                } else {
                    console.log("AuraLense BG: API Key updated and saved.");
                    sendResponse({ success: true, message: "API Key saved!" });
                }
            });
        } else {
            sendResponse({ success: false, message: "Invalid API key." });
        }
        return true; // Async response
    }

    if (message.type === "SPEAK_TEXT") {
        if (typeof message.payload.text === 'string' && message.payload.text.trim() !== "") {
            chrome.tts.speak(message.payload.text, { 'rate': 1.0, onEvent: function(event) { if (event.type === 'error') console.error('AuraLense BG: TTS Error:', event.errorMessage);}});
            sendResponse({ status: "speak initiated" });
        } else {
            sendResponse({ status: "no text to speak" });
        }
        return false; // Sync response
    }
    // Add other message handlers if needed
});

console.log("AuraLense background.js loaded.");