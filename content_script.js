console.log("AuraLense content_script.js loaded.");

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Content script received message:", message);
    switch (message.type) {
        case "GET_CONTRAST_ISSUES":
            const issues = findContrastIssues();
            sendResponse({ type: "CONTRAST_ISSUES_RESULT", payload: { issues: issues } });
            break;
        case "FIX_CONTRAST_ISSUES": // NEW
            if (message.payload && message.payload.issuesToFix) {
                const fixedCount = applyContrastFixes(message.payload.issuesToFix);
                sendResponse({ type: "CONTRAST_FIX_RESULT", payload: { fixedCount: fixedCount } });
            } else {
                sendResponse({ type: "CONTRAST_FIX_RESULT", payload: { fixedCount: 0, error: "No issues provided to fix." } });
            }
            break;
        case "GET_SELECTED_TEXT":
            const selectedText = window.getSelection().toString();
            sendResponse({ type: "SELECTED_TEXT_RESULT", payload: { text: selectedText } });
            break;
        case "CLICK_ELEMENT":
            if (message.payload) {
                clickElementByText(message.payload.elementType, message.payload.text);
                // Click is fire-and-forget for now, no specific response needed unless for error
                sendResponse({ type: "CLICK_RESULT", payload: { status: "click attempt initiated" } });
            }
            break;
        case "SCROLL_PAGE":
            if (message.payload) {
                scrollPage(message.payload.direction);
                sendResponse({ type: "SCROLL_RESULT", payload: { status: `scrolled ${message.payload.direction}` } });
            }
            break;
        default:
            console.warn("Content script received unknown message type:", message.type);
            // sendResponse({ error: "Unknown message type" }); // Optional: send error back
            break;
    }
    // IMPORTANT: Return true if sendResponse might be called asynchronously.
    // For most of these, it's synchronous, but GET_CONTRAST_ISSUES might be.
    // To be safe for all current and future handlers:
    return true;
});

function clickElementByText(elementType, textToFind) {
    // ... (Keep existing robust clickElementByText function from previous versions) ...
    // Example:
    let elements;
    if (elementType === "link") elements = Array.from(document.querySelectorAll('a'));
    else if (elementType === "button") elements = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'));
    else { console.warn("Unsupported element type for click:", elementType); return; }

    const targetElement = elements.find(el => {
        const elText = (el.textContent || el.innerText || el.value || el.getAttribute('aria-label') || "").trim().toLowerCase();
        return elText.includes(textToFind.toLowerCase()) && el.offsetParent !== null; // Check visibility
    });

    if (targetElement) {
        targetElement.focus();
        targetElement.click();
        console.log(`AuraLense: Clicked ${elementType} with text matching "${textToFind}"`);
    } else {
        console.warn(`AuraLense: No visible ${elementType} found with text matching "${textToFind}"`);
        // Optionally message popup back
        // chrome.runtime.sendMessage({ type: "FEEDBACK_MESSAGE", payload: { text: `Could not find ${elementType} with text ${textToFind}` }});
    }
}

function scrollPage(direction) {
    // ... (Keep existing scrollPage function) ...
    const scrollAmount = window.innerHeight * 0.75;
    if (direction === "down") window.scrollBy(0, scrollAmount);
    else if (direction === "up") window.scrollBy(0, -scrollAmount);
    else if (direction === "top") window.scrollTo(0, 0);
    else if (direction === "bottom") window.scrollTo(0, document.body.scrollHeight);
}

// --- Contrast Checking and Fixing Logic ---
let originalStyles = new Map(); // To store original styles before fixing

function findContrastIssues() {
    // ... (Keep the robust findContrastIssues from previous version, ensure it returns elements and their computed styles) ...
    // Important: The 'issues' objects should contain enough info to re-identify the element later for fixing.
    // e.g., a unique selector or the element object itself (if careful about detachment).
    // For simplicity, let's assume the 'elementInfo' we generate is a best-effort selector or index.
    // A more robust way is to add a temporary unique ID to elements when found.

    const issues = [];
    const elementsToCheck = document.querySelectorAll('p, span, a, h1, h2, h3, h4, h5, h6, div, li, td, th, button, label, input[type="text"], textarea, [role="link"], [role="button"]');
    let elementIndex = 0; // Simple index for re-identification for this MVP

    elementsToCheck.forEach(el => {
        if (!el || el.offsetParent === null || !hasDirectText(el) || window.getComputedStyle(el).display === 'none') return;

        const style = window.getComputedStyle(el);
        const color = style.color;
        const bgColor = getEffectiveBackgroundColor(el, style); // This function is crucial

        if (color && bgColor) {
            const parsedColor = parseColor(color);
            const parsedBgColor = parseColor(bgColor);

            if (parsedColor && parsedBgColor) {
                const ratio = getContrastRatio(parsedColor, parsedBgColor);
                // WCAG AA: 4.5 for normal text, 3 for large text (18pt or 14pt bold)
                const fontSize = parseFloat(style.fontSize);
                const isBold = parseInt(style.fontWeight) >= 700 || style.fontWeight === 'bold';
                const threshold = (fontSize >= 18 || (fontSize >= 14 && isBold)) ? 3 : 4.5;

                if (ratio < threshold) {
                    let textContent = el.textContent || el.value || el.innerText || "";
                    const uniqueId = `auralense-contrast-el-${elementIndex++}`; // Assign a temporary ID
                    el.setAttribute('data-auralense-id', uniqueId);

                    issues.push({
                        uniqueId: uniqueId, // Store this ID
                        text: textContent.trim().substring(0, 50),
                        ratio: ratio.toFixed(2),
                        originalColor: color,
                        originalBgColor: bgColor,
                        isLargeText: threshold === 3
                    });
                }
            }
        }
    });
    return issues;
}


function applyContrastFixes(issuesToFix) {
    let fixedCount = 0;
    issuesToFix.forEach(issue => {
        const element = document.querySelector(`[data-auralense-id="${issue.uniqueId}"]`);
        if (!element) {
            console.warn("Could not find element to fix contrast:", issue.uniqueId);
            return;
        }

        // Store original style if not already stored
        if (!originalStyles.has(element)) {
            originalStyles.set(element, { color: element.style.color, backgroundColor: element.style.backgroundColor });
        }

        const currentFg = parseColor(issue.originalColor);
        const currentBg = parseColor(issue.originalBgColor);
        const targetRatio = issue.isLargeText ? 3.0 : 4.5;

        if (!currentFg || !currentBg) return; // Cannot fix if colors are unparsable

        // Simple strategy: Make background white or black, then adjust text.
        // More advanced: try to maintain original hue, adjust lightness.

        let newFg, newBg;

        // Determine if original background is light or dark
        const bgLuminance = getLuminance(currentBg);
        if (bgLuminance === null) return; // Cannot determine if bg is light or dark

        if (bgLuminance > 0.5) { // Light background
            newBg = { r: 255, g: 255, b: 255 }; // Make background white
            newFg = findGoodContrastColor(newBg, currentFg, targetRatio, true); // Find dark foreground
            if (!newFg) newFg = { r: 0, g: 0, b: 0 }; // Fallback to black
        } else { // Dark background
            newBg = { r: 0, g: 0, b: 0 }; // Make background black
            newFg = findGoodContrastColor(newBg, currentFg, targetRatio, false); // Find light foreground
            if (!newFg) newFg = { r: 255, g: 255, b: 255 }; // Fallback to white
        }
        
        // Check if the new combination actually meets the target
        const achievedRatio = getContrastRatio(newFg, newBg);
        if (achievedRatio >= targetRatio) {
            element.style.setProperty('color', `rgb(${newFg.r}, ${newFg.g}, ${newFg.b})`, 'important');
            // Only set background if it's different and not transparent to avoid breaking layouts
            // This is tricky because getEffectiveBackgroundColor might have come from a parent.
            // For simplicity, we'll apply it, but this can have side effects.
            // A better approach for background is much more complex.
            // For now, we focus on text color change which is safer.
            // element.style.setProperty('background-color', `rgb(${newBg.r}, ${newBg.g}, ${newBg.b})`, 'important');
            
            // Safer: primarily adjust text color. If background was transparent, this is complex.
            // Let's try adjusting only text color relative to its *effective* background.
            let adjustedFg;
            if (bgLuminance > 0.5) { // Effective BG is light
                adjustedFg = findGoodContrastColor(currentBg, currentFg, targetRatio, true); // Aim for darker text
                 if (!adjustedFg) adjustedFg = {r:0,g:0,b:0}; // Fallback black
            } else { // Effective BG is dark
                adjustedFg = findGoodContrastColor(currentBg, currentFg, targetRatio, false); // Aim for lighter text
                 if (!adjustedFg) adjustedFg = {r:255,g:255,b:255}; // Fallback white
            }
            const newRatioWithOriginalBg = getContrastRatio(adjustedFg, currentBg);
            if (newRatioWithOriginalBg >= targetRatio) {
                 element.style.setProperty('color', `rgb(${adjustedFg.r}, ${adjustedFg.g}, ${adjustedFg.b})`, 'important');
                 console.log(`Fixed contrast for ${issue.uniqueId} by changing text color. New ratio: ${newRatioWithOriginalBg.toFixed(2)}`);
                 fixedCount++;
            } else {
                // Fallback: if just changing text color isn't enough, then change both (more intrusive)
                element.style.setProperty('color', `rgb(${newFg.r}, ${newFg.g}, ${newFg.b})`, 'important');
                element.style.setProperty('background-color', `rgb(${newBg.r}, ${newBg.g}, ${newBg.b})`, 'important'); // More aggressive
                console.log(`Aggressively fixed contrast for ${issue.uniqueId}. New ratio: ${achievedRatio.toFixed(2)}`);
                fixedCount++;
            }
        } else {
            console.warn(`Could not find a good contrast fix for element ${issue.uniqueId}. Target: ${targetRatio}, Achieved: ${achievedRatio.toFixed(2)}`);
        }
    });
    return fixedCount;
}

// Helper to find a contrasting color
// targetIsDarker: if true, try to make currentFg darker; if false, try to make it lighter
function findGoodContrastColor(bgColorRGB, currentFgRGB, targetRatio, targetIsDarker) {
    let bestFg = null;
    let bestRatio = 0;

    for (let i = 0; i < 15; i++) { // Try up to 15 adjustments
        let R = currentFgRGB.r;
        let G = currentFgRGB.g;
        let B = currentFgRGB.b;
        const step = 15 * i;

        if (targetIsDarker) {
            R = Math.max(0, R - step);
            G = Math.max(0, G - step);
            B = Math.max(0, B - step);
        } else {
            R = Math.min(255, R + step);
            G = Math.min(255, G + step);
            B = Math.min(255, B + step);
        }
        const candidateFg = { r: R, g: G, b: B };
        const ratio = getContrastRatio(candidateFg, bgColorRGB);

        if (ratio >= targetRatio) {
            return candidateFg; // Found a good one
        }
        if (ratio > bestRatio) { // Keep track of the best one found so far if target not met
            bestRatio = ratio;
            bestFg = candidateFg;
        }
         // If we hit black or white and still no good ratio, stop for that direction
        if (targetIsDarker && R === 0 && G === 0 && B === 0) break;
        if (!targetIsDarker && R === 255 && G === 255 && B === 255) break;
    }
    return bestFg; // Return the best effort if target not met
}


// --- Utility functions for contrast (getEffectiveBackgroundColor, parseColor, getLuminance, getContrastRatio, hasDirectText) ---
// Ensure these are robust from previous versions.
function getEffectiveBackgroundColor(element, style) {
    let currentElement = element;
    let currentStyle = style;
    while (currentElement) {
        let bgColor = currentStyle.backgroundColor;
        if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
            return bgColor;
        }
        // If element is body and no bg color, assume white (common browser default)
        if (currentElement.tagName === 'BODY' || currentElement.tagName === 'HTML') {
            // Check if html or body has explicit background
            const bodyHtmlStyle = window.getComputedStyle(document.documentElement);
            if (bodyHtmlStyle.backgroundColor && bodyHtmlStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && bodyHtmlStyle.backgroundColor !== 'transparent') {
                return bodyHtmlStyle.backgroundColor;
            }
            return 'rgb(255, 255, 255)';
        }
        currentElement = currentElement.parentElement;
        if (currentElement) {
            currentStyle = window.getComputedStyle(currentElement);
        } else {
            return 'rgb(255, 255, 255)';
        }
    }
    return 'rgb(255, 255, 255)';
}

function parseColor(colorStr) {
    // ... (Keep robust parseColor from previous version that handles rgb, rgba, hex) ...
    if (!colorStr) return null;
    colorStr = String(colorStr);
    let match = colorStr.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\)/);
    if (match) return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
    
    if (colorStr.startsWith("#")) {
        let hex = colorStr.slice(1);
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        if (hex.length === 6) {
            return { r: parseInt(hex.substring(0,2), 16), g: parseInt(hex.substring(2,4), 16), b: parseInt(hex.substring(4,6), 16) };
        }
    }
    if (colorStr === "transparent" || colorStr.startsWith("rgba(0, 0, 0, 0)")) return null; 
    return null; // Default for unparsable
}

function getLuminance(color) {
    // ... (Keep existing getLuminance) ...
    if (!color || typeof color.r === 'undefined') return null;
    const sRGB = [color.r, color.g, color.b].map(cVal => {
        let c = cVal / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
}

function getContrastRatio(color1, color2) {
    // ... (Keep existing getContrastRatio) ...
    if (!color1 || !color2) return 1; // Treat as failing if unparsable
    const lum1 = getLuminance(color1);
    const lum2 = getLuminance(color2);
    if (lum1 === null || lum2 === null) return 1;
    const brightest = Math.max(lum1, lum2);
    const darkest = Math.min(lum1, lum2);
    return (brightest + 0.05) / (darkest + 0.05);
}

function hasDirectText(element) {
    // ... (Keep existing hasDirectText) ...
    if (!element.childNodes) return false;
    for (let i = 0; i < element.childNodes.length; i++) {
        if (element.childNodes[i].nodeType === Node.TEXT_NODE && element.childNodes[i].nodeValue.trim() !== '') {
            return true;
        }
    }
    return false;
}