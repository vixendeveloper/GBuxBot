const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

// --- Firebase Initialization ---
// Ensure FIREBASE_ADMIN_SDK_KEY is set in Render Environment Variables
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "YOUR_FIREBASE_DATABASE_URL" // Optional: Add if you need Realtime Database
});

const db = admin.firestore();

// --- Data Storage References ---
const channelsRef = db.collection('botSettings').doc('channels');
const sourceCodesRef = db.collection('sourceCodes');
const settingsRef = db.collection('botSettings').doc('settings'); // For referralCoinReward

// --- Telegram Bot Setup ---
const token = process.env.BOT_TOKEN;
const botUsername = process.env.BOT_USERNAME; // For generating referral links
const adminUserId = parseInt(process.env.ADMIN_USER_ID); // Ensure this is a number

if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Please set it in environment variables.");
    process.exit(1);
}
if (!botUsername) {
    console.error("BOT_USERNAME is not set. Please set it in environment variables.");
    process.exit(1);
}
if (isNaN(adminUserId)) {
    console.error("ADMIN_USER_ID is not set or invalid. Please set it in environment variables.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- Express Setup for Admin Panel (if you're using it) ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' folder
app.use(bodyParser.urlencoded({ extended: true }));

// --- Helper Functions ---

async function getUser(userId) {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (userDoc.exists) {
        return userDoc.data();
    }
    // Create new user if not exists
    await db.collection('users').doc(String(userId)).set({
        balance: 0,
        referredCount: 0,
        referredBy: null,
        joinedChannels: {} // Key: channelUsername, Value: boolean (true if joined)
    });
    return { balance: 0, referredCount: 0, referredBy: null, joinedChannels: {} };
}

async function updateUser(userId, data) {
    await db.collection('users').doc(String(userId)).set(data, { merge: true });
}

async function getChannels() {
    const doc = await channelsRef.get();
    if (doc.exists && doc.data().list) {
        return doc.data().list;
    }
    return [];
}

async function addChannel(channelUsername) {
    const currentChannels = await getChannels();
    if (!currentChannels.includes(channelUsername)) {
        await channelsRef.set({ list: [...currentChannels, channelUsername] });
        return true;
    }
    return false;
}

async function removeChannel(channelUsername) {
    const currentChannels = await getChannels();
    const updatedChannels = currentChannels.filter(c => c !== channelUsername);
    if (currentChannels.length > updatedChannels.length) {
        await channelsRef.set({ list: updatedChannels });
        return true;
    }
    return false;
}

async function getSourceCodes() {
    const snapshot = await sourceCodesRef.get();
    const sourceCodes = [];
    snapshot.forEach(doc => {
        sourceCodes.push({ id: doc.id, ...doc.data() });
    });
    return sourceCodes.sort((a, b) => parseInt(a.id) - parseInt(b.id)); // Sort by ID
}

async function addSourceCode(data) {
    const newId = Date.now().toString(); // Use timestamp or a more robust ID generation
    await sourceCodesRef.doc(newId).set({ ...data, id: newId });
    return newId;
}

async function removeSourceCode(sourceCodeId) {
    await sourceCodesRef.doc(sourceCodeId).delete();
}

async function getSettings() {
    const doc = await settingsRef.get();
    if (doc.exists && doc.data().referralCoinReward !== undefined) {
        return doc.data();
    }
    return { referralCoinReward: 10 }; // Default value
}

async function setReferralCoinReward(reward) {
    await settingsRef.set({ referralCoinReward: reward });
}

async function checkChannelMembership(userId, channelUsername) {
    try {
        const chatMember = await bot.getChatMember(channelUsername, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        console.error(`Error checking membership for user ${userId} in ${channelUsername}:`, error.message);
        return false; // Assume not joined if error
    }
}

function getReferralLink(userId) {
    // Ensure botUsername is correctly set from environment variables
    return `https://t.me/${botUsername}?start=${userId}`;
}

// --- Bot Commands ---

bot.onText(/\/start(?: (\d+))?/, async (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const referrerId = match[1] ? parseInt(match[1]) : null;

    let user = await getUser(userId);

    // Handle referral
    if (referrerId && referrerId !== userId) {
        const referrer = await getUser(referrerId);
        const settings = await getSettings();
        const reward = settings.referralCoinReward || 10;

        if (referrer) {
            referrer.referredCount++;
            user.referredBy = referrerId; // Assign who referred this user
            referrer.balance += reward;
            await updateUser(referrerId, { balance: referrer.balance, referredCount: referrer.referredCount });
            bot.sendMessage(referrerId, `🥳 You just earned ${reward} SpyCoin for a new referral! Your balance is now ${referrer.balance}.`);
            console.log(`User ${userId} referred by ${referrerId}. Referrer balance updated.`);
        }
        await updateUser(userId, { referredBy: referrerId }); // Update the current user's referrer info
    }

    // Check channel memberships
    const channels = await getChannels();
    let channelsToJoin = [];
    const userJoinedChannels = user.joinedChannels || {}; // Initialize if not exists

    for (const channel of channels) {
        const isJoined = await checkChannelMembership(userId, channel);
        if (!isJoined) {
            channelsToJoin.push(channel);
        }
        userJoinedChannels[channel] = isJoined; // Update joined status
    }

    user.joinedChannels = userJoinedChannels; // Update user's joined channel status
    await updateUser(userId, { joinedChannels: user.joinedChannels }); // Save updated joinedChannels status

    if (channelsToJoin.length > 0) {
        let message = "Please join the following channels first to access the bot:\n\n";
        channelsToJoin.forEach(channel => {
            message += `- [${channel}](https://t.me/${channel.substring(1)})\n`; // Link to channel
        });
        message += "\nAfter joining, please send `/start` again.";

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } else {
        // If all channels are joined, show the main menu
        showMainMenu(chatId, userId);
    }
});

// --- Main Menu Handler ---
async function showMainMenu(chatId, userId) {
    const user = await getUser(userId); // Get fresh user data
    const keyboard = [
        [{ text: '✨ Source Codes', callback_data: 'source_codes' }],
        [{ text: '💰 Balance', callback_data: 'balance' }, { text: '🔗 Refer', callback_data: 'refer' }]
    ];
    bot.sendMessage(chatId, '🌟 Welcome to the Main Menu!', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

// --- Callback Query Handler ---
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    // Answer the callback query to remove the "loading" effect
    bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'source_codes') {
        showSourceCodesMenu(chatId, userId);
    } else if (data === 'balance') {
        showBalance(chatId, userId);
    } else if (data === 'refer') {
        showReferralInfo(chatId, userId);
    } else if (data.startsWith('view_source_code_')) {
        const sourceCodeId = data.split('_')[3];
        await viewSourceCode(chatId, userId, sourceCodeId);
    } else if (data.startsWith('unlock_source_code_')) {
        const sourceCodeId = data.split('_')[3];
        await unlockSourceCode(chatId, userId, sourceCodeId, message.message_id); // Pass message_id for editing
    } else if (data === 'earn') {
        bot.editMessageText("⏳ Coming Soon!", {
            chat_id: chatId,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: [] }
        });
    } else if (data === 'next_source_code') {
        const currentSourceCodeId = message.text.match(/Source Code ID: (\d+)/)?.[1]; // Assuming ID is in message text
        if (currentSourceCodeId) {
            const allSourceCodes = await getSourceCodes();
            const currentIndex = allSourceCodes.findIndex(sc => sc.id === currentSourceCodeId);
            if (currentIndex !== -1 && currentIndex < allSourceCodes.length - 1) {
                const nextSourceCode = allSourceCodes[currentIndex + 1];
                await bot.deleteMessage(chatId, message.message_id); // Delete current message
                await viewSourceCode(chatId, userId, nextSourceCode.id);
            } else {
                bot.editMessageText("No more source codes available at the moment.", {
                    chat_id: chatId,
                    message_id: message.message_id,
                    reply_markup: { inline_keyboard: [] }
                });
            }
        }
    } else if (data === 'back_to_source_codes') {
        showSourceCodesMenu(chatId, userId);
    } else if (data === 'main_menu') {
        showMainMenu(chatId, userId);
    }
});

// --- Menu/Info Display Functions ---

async function showBalance(chatId, userId) {
    const user = await getUser(userId);
    bot.sendMessage(chatId, `Your current SpyCoin balance is: ${user.balance} SpyCoin 💰`);
}

async function showReferralInfo(chatId, userId) {
    const user = await getUser(userId);
    const referralLink = getReferralLink(userId);

    const keyboard = [
        [{ text: 'Copy Link', url: `https://t.me/${botUsername}?start=${userId}` }] // Telegram allows opening links directly
        // NOTE: Telegram doesn't have a native 'copy' button for bots that truly copies to clipboard.
        // The 'url' approach opens the link, which is the closest.
        // Alternatively, send the link as a message and instruct user to copy.
        , [{ text: 'Back to Main Menu', callback_data: 'main_menu' }]
    ];

    bot.sendMessage(chatId, `🔗 Your Referral Link: \n${referralLink}\n\nFriends referred by you: ${user.referredCount}\n\nEarn ${ (await getSettings()).referralCoinReward || 10 } SpyCoin for each successful referral!`, {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function showSourceCodesMenu(chatId, userId) {
    const sourceCodes = await getSourceCodes();
    if (sourceCodes.length === 0) {
        bot.sendMessage(chatId, "No source codes available yet.");
        return;
    }

    const keyboard = sourceCodes.map(sc => [
        { text: `🔗 ${sc.caption.substring(0, 30)}...`, callback_data: `view_source_code_${sc.id}` }
    ]);
    keyboard.push([{ text: 'Back to Main Menu', callback_data: 'main_menu' }]);

    bot.sendMessage(chatId, 'Here are the available Source Codes:', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function viewSourceCode(chatId, userId, sourceCodeId) {
    const user = await getUser(userId);
    const sourceCodes = await getSourceCodes();
    const sourceCode = sourceCodes.find(sc => sc.id === sourceCodeId);

    if (!sourceCode) {
        bot.sendMessage(chatId, "Source code not found.");
        return;
    }

    const isUnlocked = user.balance >= sourceCode.unlockCost;

    let messageText = `✨ **${sourceCode.caption}** ✨\n\n`;
    if (sourceCode.imageLink) messageText += `[Image Preview](${sourceCode.imageLink})\n\n`;
    messageText += `Unlock Cost: ${sourceCode.unlockCost} SpyCoin 💰\n`;
    messageText += `Source Code ID: ${sourceCode.id}\n`; // Added for navigation logic

    let inlineKeyboard = [];

    if (isUnlocked) {
        inlineKeyboard.push([
            { text: 'Open Source Code', url: sourceCode.fileLink }
        ]);
    } else {
        inlineKeyboard.push([
            { text: 'Unlock File', callback_data: `unlock_source_code_${sourceCode.id}` }
        ]);
        inlineKeyboard.push([
            { text: 'Earn More Coins', callback_data: 'earn' }
        ]);
    }

    // Navigation buttons
    const currentIndex = sourceCodes.findIndex(sc => sc.id === sourceCodeId);
    let navButtons = [];
    if (currentIndex > 0) {
        navButtons.push({ text: 'Back', callback_data: `view_source_code_${sourceCodes[currentIndex - 1].id}` });
    }
    if (currentIndex < sourceCodes.length - 1) {
        navButtons.push({ text: 'Next', callback_data: `view_source_code_${sourceCodes[currentIndex + 1].id}` }); // Changed from next_source_code to view_source_code_
    }
    if (navButtons.length > 0) {
        inlineKeyboard.push(navButtons);
    }

    inlineKeyboard.push([{ text: 'Back to Source Codes', callback_data: 'back_to_source_codes' }]);

    bot.sendMessage(chatId, messageText, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: inlineKeyboard
        }
    });
}

async function unlockSourceCode(chatId, userId, sourceCodeId, messageId) {
    let user = await getUser(userId);
    const sourceCodes = await getSourceCodes();
    const sourceCode = sourceCodes.find(sc => sc.id === sourceCodeId);

    if (!sourceCode) {
        bot.sendMessage(chatId, "Source code not found.");
        return;
    }

    if (user.balance >= sourceCode.unlockCost) {
        user.balance -= sourceCode.unlockCost;
        await updateUser(userId, { balance: user.balance });

        // Edit the message to show the link
        await bot.editMessageText(`✨ **${sourceCode.caption}** ✨\n\n${sourceCode.imageLink ? `[Image Preview](${sourceCode.imageLink})\n\n` : ''}Unlocked! Here is your link:\n[Open Source Code](${sourceCode.fileLink})`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] } // Clear buttons
        });
    } else {
        bot.sendMessage(chatId, `You need ${sourceCode.unlockCost} SpyCoin to unlock this. Your current balance is ${user.balance} SpyCoin.`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Earn More Coins', callback_data: 'earn' }],
                    [{ text: 'Back', callback_data: `view_source_code_${sourceCodeId}` }]
                ]
            }
        });
    }
}

// --- Admin Commands (using Telegram Bot) ---
// These commands will interact with Firebase via helper functions

bot.onText(/\/adminhelp/, (msg) => {
    if (msg.from.id != adminUserId) {
        bot.sendMessage(msg.chat.id, "You are not authorized to use admin commands.");
        return;
    }
    const helpText = `
    **Admin Commands:**
    /addchannel @channelusername
    /removechannel @channelusername
    /listchannels
    /addsourcecode caption|imageLink|fileLink|unlockCost
    /removesourcecode sourceCodeId
    /listsourcecodes
    /setreferreward amount
    /getreward
    `;
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/addchannel (.+)/, async (msg, match) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const channelUsername = match[1].trim();
    if (!channelUsername.startsWith('@')) {
        return bot.sendMessage(msg.chat.id, "Channel username must start with '@'.");
    }
    const added = await addChannel(channelUsername);
    if (added) {
        bot.sendMessage(msg.chat.id, `Channel ${channelUsername} added successfully.`);
    } else {
        bot.sendMessage(msg.chat.id, `Channel ${channelUsername} is already in the list.`);
    }
});

bot.onText(/\/removechannel (.+)/, async (msg, match) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const channelUsername = match[1].trim();
    const removed = await removeChannel(channelUsername);
    if (removed) {
        bot.sendMessage(msg.chat.id, `Channel ${channelUsername} removed successfully.`);
    } else {
        bot.sendMessage(msg.chat.id, `Channel ${channelUsername} not found.`);
    }
});

bot.onText(/\/listchannels/, async (msg) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const channels = await getChannels();
    if (channels.length === 0) {
        bot.sendMessage(msg.chat.id, "No channels added yet.");
    } else {
        let message = "Current Channels:\n";
        channels.forEach(c => message += `- ${c}\n`);
        bot.sendMessage(msg.chat.id, message);
    }
});

bot.onText(/\/addsourcecode (.+)/, async (msg, match) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const parts = match[1].split('|').map(p => p.trim());
    if (parts.length === 4) {
        const [caption, imageLink, fileLink, unlockCostStr] = parts;
        const unlockCost = parseInt(unlockCostStr);

        if (isNaN(unlockCost) || unlockCost < 0) {
            return bot.sendMessage(msg.chat.id, "Invalid unlock cost. Please provide a non-negative number.");
        }

        const newId = await addSourceCode({ caption, imageLink: imageLink || null, fileLink, unlockCost });
        bot.sendMessage(msg.chat.id, `Source code "${caption}" added successfully with ID ${newId}.`);
    } else {
        bot.sendMessage(msg.chat.id, "Invalid format. Use: /addsourcecode caption|imageLink|fileLink|unlockCost");
    }
});

bot.onText(/\/removesourcecode (\d+)/, async (msg, match) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const sourceCodeId = match[1];
    await removeSourceCode(sourceCodeId);
    // TODO: Check if removal was successful and respond accordingly
    bot.sendMessage(msg.chat.id, `Attempted to remove source code with ID ${sourceCodeId}.`);
});

bot.onText(/\/listsourcecodes/, async (msg) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const sourceCodes = await getSourceCodes();
    if (sourceCodes.length === 0) {
        bot.sendMessage(msg.chat.id, "No source codes added yet.");
    } else {
        let message = "Current Source Codes:\n\n";
        sourceCodes.forEach(sc => {
            message += `ID: ${sc.id}\n`;
            message += `Caption: ${sc.caption}\n`;
            message += `Unlock Cost: ${sc.unlockCost} SpyCoin\n`;
            message += `Image: ${sc.imageLink || 'N/A'}\n`;
            message += `File Link: ${sc.fileLink}\n`;
            message += "--------------------\n";
        });
        bot.sendMessage(msg.chat.id, message);
    }
});

bot.onText(/\/setreferreward (\d+)/, async (msg, match) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const reward = parseInt(match[1]);
    if (!isNaN(reward) && reward >= 0) {
        await setReferralCoinReward(reward);
        bot.sendMessage(msg.chat.id, `Referral coin reward set to ${reward} SpyCoin.`);
    } else {
        bot.sendMessage(msg.chat.id, "Invalid reward amount. Please provide a non-negative number.");
    }
});

bot.onText(/\/getreward/, async (msg) => {
    if (msg.from.id != adminUserId) return bot.sendMessage(msg.chat.id, "Unauthorized.");
    const settings = await getSettings();
    bot.sendMessage(msg.chat.id, `Current referral coin reward is: ${settings.referralCoinReward} SpyCoin.`);
});


// --- Error Handling ---
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.code, error.message);
});

bot.on('error', (error) => {
    console.error('General error:', error);
});


// --- Start Server and Bot ---
// Add Express routes for Admin Panel here if you want to use it
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html')); // Assuming admin.html is in 'public' folder
});

// Example POST route for adding a channel via admin panel
app.post('/admin/addchannel', async (req, res) => {
    const { channelUsername } = req.body;
    // ** IMPORTANT: Implement admin authentication here! **
    // For simplicity, we'll rely on the Telegram bot's admin check for now if using admin panel.
    // A robust solution would involve session management or API keys.
    if (!channelUsername || !channelUsername.startsWith('@')) {
        return res.status(400).send("Invalid channel username. Must start with '@'.");
    }
    const added = await addChannel(channelUsername);
    if (added) {
        res.redirect(`/admin?message=Channel ${channelUsername} added successfully!`);
    } else {
        res.redirect(`/admin?message=Channel ${channelUsername} already exists.`);
    }
});

// Example POST route for setting referral reward via admin panel
app.post('/admin/setreferreward', async (req, res) => {
    const { reward } = req.body;
    const rewardNum = parseInt(reward);
    if (isNaN(rewardNum) || rewardNum < 0) {
        return res.status(400).send("Invalid reward. Must be a non-negative number.");
    }
    await setReferralCoinReward(rewardNum);
    res.redirect(`/admin?message=Referral reward set to ${rewardNum} SpyCoin.`);
});

// Add other admin POST routes similarly...
// For add/remove source code, you might need a more complex form and handling.


app.listen(port, () => {
    console.log(`Express server running on port ${port}`);
});

// Start Telegram Bot polling
bot.startPolling().then(() => {
    console.log('Telegram Bot is running and polling...');
}).catch(err => {
    console.error("Failed to start Telegram Bot polling:", err);
    process.exit(1);
});
