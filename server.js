const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

// --- Firebase Initialization ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK_KEY);
} catch (e) {
    console.error("Failed to parse FIREBASE_ADMIN_SDK_KEY. Ensure it's a valid JSON string.", e);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// --- Data Storage References ---
const channelsRef = db.collection('botSettings').doc('channels');
const sourceCodesRef = db.collection('sourceCodes');
const settingsRef = db.collection('botSettings').doc('settings');

// --- Telegram Bot Setup ---
const token = process.env.BOT_BOT_TOKEN; // Renamed to avoid confusion with previous POST method
const botUsername = process.env.BOT_USERNAME;
const adminUserId = parseInt(process.env.ADMIN_USER_ID); // Use the Admin Chat ID from environment variable

if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set.");
    process.exit(1);
}
if (!botUsername) {
    console.error("BOT_USERNAME is not set.");
    process.exit(1);
}
if (isNaN(adminUserId)) {
    console.error("ADMIN_USER_ID is not set or invalid. Please ensure it's a number.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- Express Setup ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// --- State Management for Admin Actions ---
const adminState = {}; // Stores intermediate data for multi-step admin actions

// --- Helper Functions ---

async function getUser(userId) {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (userDoc.exists) {
        return userDoc.data();
    }
    const newUser = {
        balance: 0,
        referredCount: 0,
        referredBy: null,
        joinedChannels: {}
    };
    await db.collection('users').doc(String(userId)).set(newUser);
    return newUser;
}

async function updateUser(userId, data) {
    await db.collection('users').doc(String(userId)).set(data, { merge: true });
}

async function getChannels() {
    const doc = await channelsRef.get();
    if (doc.exists && doc.data().list) return doc.data().list;
    return [];
}

async function addChannel(channelUsername, channelLink) {
    const currentChannels = await getChannels();
    const existingChannel = currentChannels.find(c => c.username === channelUsername);
    if (existingChannel) return false;
    await channelsRef.set({ list: [...currentChannels, { username: channelUsername, link: channelLink }] });
    return true;
}

async function removeChannel(channelUsername) {
    const currentChannels = await getChannels();
    const updatedChannels = currentChannels.filter(c => c.username !== channelUsername);
    if (currentChannels.length > updatedChannels.length) {
        await channelsRef.set({ list: updatedChannels });
        return true;
    }
    return false;
}

async function getSourceCodes() {
    const snapshot = await sourceCodesRef.get();
    const sourceCodes = [];
    snapshot.forEach(doc => { sourceCodes.push({ id: doc.id, ...doc.data() }); });
    return sourceCodes.sort((a, b) => parseInt(a.id) - parseInt(b.id));
}

async function addSourceCode(data) {
    const newId = Date.now().toString(); // Consider a more robust ID strategy for production
    await sourceCodesRef.doc(newId).set({ ...data, id: newId });
    return newId;
}

async function removeSourceCode(sourceCodeId) {
    await sourceCodesRef.doc(sourceCodeId).delete();
}

async function getSettings() {
    const doc = await settingsRef.get();
    if (doc.exists && doc.data().referralCoinReward !== undefined) return doc.data();
    return { referralCoinReward: 10 };
}

async function setReferralCoinReward(reward) {
    await settingsRef.set({ referralCoinReward: reward });
}

async function checkChannelMembership(userId, channel) {
    try {
        const chatMember = await bot.getChatMember(channel.username, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        console.error(`Error checking membership for user ${userId} in ${channel.username}:`, error.message);
        return false;
    }
}

function getReferralLink(userId) {
    return `https://t.me/${botUsername}?start=${userId}`;
}

// --- Bot Commands ---

bot.onText(/\/start(?: (\d+))?/, async (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const referrerId = match[1] ? parseInt(match[1]) : null;

    let user = await getUser(userId);

    if (referrerId && referrerId !== userId) {
        const referrer = await getUser(referrerId);
        const settings = await getSettings();
        const reward = settings.referralCoinReward || 10;

        if (referrer) {
            referrer.referredCount++;
            user.referredBy = referrerId;
            referrer.balance += reward;
            await updateUser(referrerId, { balance: referrer.balance, referredCount: referrer.referredCount });
            bot.sendMessage(referrerId, `🥳 You just earned ${reward} SpyCoin for a new referral! Your balance is now ${referrer.balance}.`);
        }
        await updateUser(userId, { referredBy: referrerId });
    }

    const channels = await getChannels();
    let channelsToJoin = [];
    const userJoinedChannels = user.joinedChannels || {};

    for (const channel of channels) {
        const isJoined = await checkChannelMembership(userId, channel);
        userJoinedChannels[channel.username] = isJoined;
        if (!isJoined) channelsToJoin.push(channel);
    }

    user.joinedChannels = userJoinedChannels;
    await updateUser(userId, { joinedChannels: user.joinedChannels });

    if (channelsToJoin.length > 0) {
        let message = "Please join the following channels first to access the bot:\n\n";
        channelsToJoin.forEach(channel => { message += `- [${channel.username}](${channel.link})\n`; });
        message += "\nAfter joining, please send `/start` again.";
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } else {
        showMainMenu(chatId, userId);
    }
});

// --- Main Menu Handler ---
async function showMainMenu(chatId, userId) {
    const keyboard = [
        [{ text: '✨ Source Codes' }],
        [{ text: '💰 Balance' }, { text: '🔗 Refer' }]
    ];
    bot.sendMessage(chatId, '🌟 *Welcome to the Main Menu!*', {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: keyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });

    const adsMessage = "*Ads* - [খুচরো ডলার বিক্রি করুন](https://t.me/RedExChangerBot/app)";
    bot.sendMessage(chatId, adsMessage, { parse_mode: 'Markdown' });
}

// --- Callback Query Handler (for Source Codes and specific inline buttons) ---
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

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
        await unlockSourceCode(chatId, userId, sourceCodeId, message.message_id);
    } else if (data === 'earn') {
        bot.editMessageText("⏳ Coming Soon!", { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
    } else if (data === 'next_source_code') {
        const currentSourceCodeId = message.text.match(/Source Code ID: (\d+)/)?.[1];
        if (currentSourceCodeId) {
            const allSourceCodes = await getSourceCodes();
            const currentIndex = allSourceCodes.findIndex(sc => sc.id === currentSourceCodeId);
            if (currentIndex !== -1 && currentIndex < allSourceCodes.length - 1) {
                const nextSourceCode = allSourceCodes[currentIndex + 1];
                await bot.deleteMessage(chatId, message.message_id);
                await viewSourceCode(chatId, userId, nextSourceCode.id);
            } else {
                bot.editMessageText("No more source codes available at the moment.", { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
            }
        }
    } else if (data === 'back_to_source_codes') {
        showSourceCodesMenu(chatId, userId);
    } else if (data === 'main_menu') {
        showMainMenu(chatId, userId);
    }
});

// --- Handling Keyboard Button Presses for Main Menu ---
bot.onText(/💰 Balance/, async (msg) => {
    await showBalance(msg.chat.id, msg.from.id);
});

bot.onText(/🔗 Refer/, async (msg) => {
    await showReferralInfo(msg.chat.id, msg.from.id);
});

bot.onText(/✨ Source Codes/, async (msg) => {
    await showSourceCodesMenu(msg.chat.id, msg.from.id);
});


// --- Menu/Info Display Functions ---

async function showBalance(chatId, userId) {
    const user = await getUser(userId);
    const supportGroupLink = "https://t.me/+rYxM4JzaTDE5MWM1";
    const balanceInfo = `Your current SpyCoin balance is: ${user.balance} SpyCoin 💰\n\n*User Information:*\nChat ID: \`${userId}\``;

    const keyboard = [
        [{ text: 'Join Support Group', url: supportGroupLink }],
    ];

    bot.sendMessage(chatId, balanceInfo, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function showReferralInfo(chatId, userId) {
    const user = await getUser(userId);
    const referralLink = getReferralLink(userId);
    const settings = await getSettings();
    const referralReward = settings.referralCoinReward || 10;

    const joinGroupLink = "https://t.me/+7QEDhovtqJ4yZTA1";
    const keyboard = [
        [{ text: 'Join Refer Link Share Group', url: joinGroupLink }],
    ];

    bot.sendMessage(chatId, `🔗 Your Referral Link: \n${referralLink}\n\nEarn ${referralReward} SpyCoin for each successful referral!`, {
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
    messageText += `Source Code ID: ${sourceCode.id}\n`;

    let inlineKeyboard = [];

    if (isUnlocked) {
        // If fileId is stored, use sendDocument. If fileLink, use URL.
        if (sourceCode.fileId) {
            inlineKeyboard.push([{ text: 'Open Source Code', callback_data: `send_file_${sourceCode.id}` }]);
        } else if (sourceCode.fileLink) {
            inlineKeyboard.push([{ text: 'Open Source Code', url: sourceCode.fileLink }]);
        }
    } else {
        inlineKeyboard.push([{ text: 'Unlock File', callback_data: `unlock_source_code_${sourceCode.id}` }]);
        inlineKeyboard.push([{ text: 'Earn More Coins', callback_data: 'earn' }]);
    }

    const currentIndex = sourceCodes.findIndex(sc => sc.id === sourceCodeId);
    let navButtons = [];
    if (currentIndex > 0) {
        navButtons.push({ text: 'Back', callback_data: `view_source_code_${sourceCodes[currentIndex - 1].id}` });
    }
    if (currentIndex < sourceCodes.length - 1) {
        navButtons.push({ text: 'Next', callback_data: `view_source_code_${sourceCodes[currentIndex + 1].id}` });
    }
    if (navButtons.length > 0) inlineKeyboard.push(navButtons);

    inlineKeyboard.push([{ text: 'Back to Source Codes', callback_data: 'back_to_source_codes' }]);

    bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
}

// Handler to send file via file_id when unlocked
bot.onText(/send_file_(\d+)/, async (msg, match) => {
    const sourceCodeId = match[1];
    const userId = msg.from.id;
    const sourceCodes = await getSourceCodes();
    const sourceCode = sourceCodes.find(sc => sc.id === sourceCodeId);

    if (!sourceCode) {
        bot.sendMessage(msg.chat.id, "Source code not found.");
        return;
    }

    if (!sourceCode.fileId) {
        bot.sendMessage(msg.chat.id, "File not available for this source code.");
        return;
    }

    // Check if user has enough balance (re-check or assume they do since they unlocked)
    const user = await getUser(userId);
    if (user.balance < sourceCode.unlockCost) {
         bot.sendMessage(msg.chat.id, `You need ${sourceCode.unlockCost} SpyCoin to unlock this. Your current balance is ${user.balance} SpyCoin.`);
         return;
    }

    try {
        await bot.sendDocument(msg.chat.id, sourceCode.fileId, { caption: `Here is your source code: ${sourceCode.caption}` });
        // Optionally, remove the file sending button or update message
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msg.chat.id, message_id: msg.message_id });
    } catch (error) {
        console.error("Error sending document:", error);
        bot.sendMessage(msg.chat.id, "Failed to send the file. Please contact support.");
    }
});


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

        // Construct the message with unlock confirmation and actions
        let unlockedMessageText = `✨ **${sourceCode.caption}** ✨\n\n`;
        if (sourceCode.imageLink) unlockedMessageText += `[Image Preview](${sourceCode.imageLink})\n\n`;
        unlockedMessageText += `Unlocked successfully! \n`;

        let unlockedKeyboard = [];
        if (sourceCode.fileId) {
            unlockedKeyboard.push([{ text: 'Open Source Code', callback_data: `send_file_${sourceCode.id}` }]);
        } else if (sourceCode.fileLink) {
            unlockedKeyboard.push([{ text: 'Open Source Code', url: sourceCode.fileLink }]);
        } else {
            unlockedMessageText += "File link or ID not available.";
        }
        unlockedMessageText += `\nCost: ${sourceCode.unlockCost} SpyCoin deducted.`;

        await bot.editMessageText(unlockedMessageText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: unlockedKeyboard }
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

// --- Admin Panel Entry Point ---
bot.onText(/\/admin/, async (msg) => {
    const userId = msg.from.id;
    // Check if the user ID matches the authorized adminUserId from environment variables
    if (userId !== adminUserId) {
        return bot.sendMessage(msg.chat.id, "You are not authorized to access the admin panel.");
    }
    // Show Admin Menu
    const adminMenuKeyboard = [
        [{ text: 'Manage Source Codes' }],
        [{ text: 'Manage Channels' }],
        [{ text: 'Manage Users' }],
        [{ text: 'Settings' }]
    ];
    bot.sendMessage(msg.chat.id, '🌟 Welcome to the Admin Panel!', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// --- Admin Panel Command Handlers (using keyboard buttons) ---

// Navigation Back to Admin Menu
const navigateBackToAdminMenu = async (chatId) => {
    const adminMenuKeyboard = [
        [{ text: 'Manage Source Codes' }],
        [{ text: 'Manage Channels' }],
        [{ text: 'Manage Users' }],
        [{ text: 'Settings' }]
    ];
    bot.sendMessage(chatId, 'Returning to Admin Panel...', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
};

// Manage Source Codes Menu
bot.onText(/Manage Source Codes/, async (msg) => {
    const adminMenuKeyboard = [
        [{ text: 'Add New Source Code' }],
        [{ text: 'Remove Source Code' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose an action for Source Codes:', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Add New Source Code Flow
bot.onText(/Add New Source Code/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_image' };
    bot.sendMessage(msg.chat.id, 'Please send the Image for the source code.');
});

// Handle Image Upload
bot.on('photo', async (msg) => {
    const userId = msg.from.id;
    if (adminState[userId] && adminState[userId].step === 'awaiting_image') {
        const photo = msg.photo[msg.photo.length - 1]; // Get the largest size
        adminState[userId].imageFileId = photo.file_id;
        adminState[userId].step = 'awaiting_caption';
        bot.sendMessage(msg.chat.id, 'Image received. Now, please send the Caption for the source code.');
    }
});

// Handle Text Input for Add Source Code Steps
bot.on('text', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!adminState[userId]) return; // Not in an admin flow

    // --- Add New Source Code Steps ---
    if (adminState[userId].step === 'awaiting_caption') {
        adminState[userId].caption = text;
        adminState[userId].step = 'awaiting_file';
        bot.sendMessage(chatId, 'Caption received. Please send the File (document) for the source code.');
    } else if (adminState[userId].step === 'awaiting_file') {
        if (msg.document) {
            adminState[userId].fileId = msg.document.file_id;
            adminState[userId].fileName = msg.document.file_name;
            adminState[userId].step = 'awaiting_cost';
            bot.sendMessage(chatId, 'File received. Now, please send the Unlock Cost (points).');
        } else {
            bot.sendMessage(chatId, 'Please send a file (document). Send /cancel to stop.');
        }
    } else if (adminState[userId].step === 'awaiting_cost') {
        const cost = parseInt(text);
        if (!isNaN(cost) && cost >= 0) {
            adminState[userId].unlockCost = cost;
            adminState[userId].step = 'confirmation';

            let confirmationMessage = `Please confirm:\nImage ID: ${adminState[userId].imageFileId || 'N/A'}\nCaption: ${adminState[userId].caption}\nFile Name: ${adminState[userId].fileName || 'N/A'}\nFile ID: ${adminState[userId].fileId || 'N/A'}\nUnlock Cost: ${adminState[userId].unlockCost}\n\nType 'confirm' to save, or 'cancel' to abort.`;
            bot.sendMessage(chatId, confirmationMessage);
        } else {
            bot.sendMessage(chatId, 'Invalid cost. Please enter a valid number for points.');
        }
    } else if (adminState[userId].step === 'confirmation') {
        if (text.toLowerCase() === 'confirm') {
            try {
                const newSourceCode = {
                    id: Date.now().toString(),
                    caption: adminState[userId].caption,
                    imageFileId: adminState[userId].imageFileId || null,
                    fileId: adminState[userId].fileId || null,
                    fileName: adminState[userId].fileName || null,
                    unlockCost: adminState[userId].unlockCost
                };
                await addSourceCode(newSourceCode);
                bot.sendMessage(chatId, 'Source code added successfully!');
            } catch (error) {
                console.error("Error adding source code:", error);
                bot.sendMessage(chatId, 'Failed to add source code. Please check logs.');
            } finally {
                delete adminState[userId];
            }
        } else if (text.toLowerCase() === 'cancel') {
            bot.sendMessage(chatId, 'Operation cancelled.');
            delete adminState[userId];
        } else {
            bot.sendMessage(chatId, 'Please type "confirm" or "cancel".');
        }
    }

    // --- Remove Source Code Confirmation ---
    else if (adminState[userId].step === 'awaiting_remove_confirmation') {
        if (text.toLowerCase() === 'yes') {
            const sourceCodeIdToRemove = adminState[userId].sourceCodeIdToRemove;
            try {
                await removeSourceCode(sourceCodeIdToRemove);
                bot.sendMessage(chatId, `Source code with ID ${sourceCodeIdToRemove} removed successfully.`);
            } catch (error) {
                console.error("Error removing source code:", error);
                bot.sendMessage(chatId, 'Failed to remove source code.');
            } finally {
                delete adminState[userId];
            }
        } else if (text.toLowerCase() === 'no') {
            bot.sendMessage(chatId, 'Removal cancelled.');
            delete adminState[userId];
        } else {
            bot.sendMessage(chatId, 'Please type "yes" or "no".');
        }
    }

    // --- Set Referral Reward ---
    else if (adminState[userId].step === 'awaiting_referral_reward') {
        const reward = parseInt(text);
        if (!isNaN(reward) && reward >= 0) {
            await setReferralCoinReward(reward);
            bot.sendMessage(chatId, `Referral coin reward set to ${reward} SpyCoin.`);
            delete adminState[userId];
        } else {
            bot.sendMessage(chatId, 'Invalid reward amount. Please enter a non-negative number.');
        }
    }

    // --- Add/Remove User Balance ---
    else if (adminState[userId].step === 'awaiting_user_id_for_balance') {
        const targetUserId = parseInt(text);
        if (!isNaN(targetUserId)) {
            adminState[userId].targetUserId = targetUserId;
            adminState[userId].step = 'awaiting_balance_amount';
            bot.sendMessage(chatId, `User ID ${targetUserId} selected. Now enter the amount to add/remove (e.g., +100 or -50).`);
        } else {
            bot.sendMessage(chatId, 'Invalid User ID. Please enter a valid Telegram User ID (numbers only).');
        }
    } else if (adminState[userId].step === 'awaiting_balance_amount') {
        const amountText = text;
        const amount = parseInt(amountText);
        if (!isNaN(amount)) {
            try {
                const targetUser = await getUser(adminState[userId].targetUserId);
                const newBalance = targetUser.balance + amount;
                await updateUser(adminState[userId].targetUserId, { balance: newBalance });
                bot.sendMessage(chatId, `Balance updated for user ${adminState[userId].targetUserId}. New balance: ${newBalance} SpyCoin.`);
            } catch (error) {
                console.error("Error updating user balance:", error);
                bot.sendMessage(chatId, 'Failed to update user balance.');
            } finally {
                delete adminState[userId];
            }
        } else {
            bot.sendMessage(chatId, 'Invalid amount. Please enter a number (e.g., +50, -20).');
        }
    }

    // --- Add Channel Steps ---
    else if (adminState[userId].step === 'awaiting_channel_username_for_add') {
        if (!text.startsWith('@')) return bot.sendMessage(chatId, 'Invalid channel username. It must start with "@".');
        adminState[userId].channelUsername = text;
        adminState[userId].step = 'awaiting_channel_link_for_add';
        bot.sendMessage(chatId, `Channel username '${text}' received. Now, please send the Channel Link (e.g., https://t.me/yourchannel).`);
    } else if (adminState[userId].step === 'awaiting_channel_link_for_add') {
        if (!text.startsWith('http')) return bot.sendMessage(chatId, 'Invalid link format. Please provide a valid URL.');
        try {
            const added = await addChannel(adminState[userId].channelUsername, text);
            if (added) {
                bot.sendMessage(chatId, `Channel '${adminState[userId].channelUsername}' with link '${text}' added successfully!`);
            } else {
                bot.sendMessage(chatId, `Channel '${adminState[userId].channelUsername}' already exists.`);
            }
        } catch (error) {
            console.error("Error adding channel:", error);
            bot.sendMessage(chatId, 'Failed to add channel.');
        } finally {
            delete adminState[userId];
        }
    }
});


// --- Admin Menu Navigation Handlers ---

// Manage Source Codes Menu
bot.onText(/Manage Source Codes/, async (msg) => {
    const adminMenuKeyboard = [
        [{ text: 'Add New Source Code' }],
        [{ text: 'Remove Source Code' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose an action for Source Codes:', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Remove Source Code Menu
bot.onText(/Remove Source Code/, async (msg) => {
    const sourceCodes = await getSourceCodes();
    if (sourceCodes.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No source codes available to remove.');
    }
    const removeSCKeyboard = sourceCodes.map(sc => [
        { text: `Remove SC ID: ${sc.id} (${sc.caption.substring(0, 20)}...)` }
    ]);
    removeSCKeyboard.push([{ text: 'Back to Source Code Admin Menu' }]);
    bot.sendMessage(msg.chat.id, 'Select a source code to remove:', {
        reply_markup: {
            keyboard: removeSCKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Process Removal of Source Code
bot.onText(/Remove SC ID: (\d+)/, async (msg, match) => {
    const sourceCodeIdToRemove = match[1];
    // Store the ID to confirm removal
    adminState[msg.from.id] = { step: 'awaiting_remove_confirmation', sourceCodeIdToRemove: sourceCodeIdToRemove };
    bot.sendMessage(msg.chat.id, `Are you sure you want to remove Source Code ID ${sourceCodeIdToRemove}? Type 'yes' or 'no'.`);
});

// Handle Channel Management Menu
bot.onText(/Manage Channels/, async (msg) => {
    const channelAdminKeyboard = [
        [{ text: 'Add New Channel' }],
        [{ text: 'Remove Channel' }],
        [{ text: 'List Channels' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose an action for Channels:', {
        reply_markup: {
            keyboard: channelAdminKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Add New Channel Flow
bot.onText(/Add New Channel/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_channel_username_for_add' };
    bot.sendMessage(msg.chat.id, 'Please send the Channel Username (e.g., @yourchannelname).');
});

// Remove Channel Flow
bot.onText(/Remove Channel/, async (msg) => {
    const channels = await getChannels();
    if (channels.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No channels added yet.');
    }
    const removeChannelKeyboard = channels.map(channel => [
        { text: `Remove ${channel.username}` }
    ]);
    removeChannelKeyboard.push([{ text: 'Back to Channel Admin Menu' }]);
    bot.sendMessage(msg.chat.id, 'Select a channel to remove:', {
        reply_markup: {
            keyboard: removeChannelKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Process Channel Removal
bot.onText(/Remove @.+/, async (msg) => {
    const channelUsernameToRemove = msg.text.replace('Remove ', '');
    const removed = await removeChannel(channelUsernameToRemove);
    if (removed) {
        bot.sendMessage(msg.chat.id, `${channelUsernameToRemove} removed successfully.`);
    } else {
        bot.sendMessage(msg.chat.id, `${channelUsernameToRemove} not found.`);
    }
    // After action, return to channel management menu
    const channelAdminKeyboard = [[{ text: 'Add New Channel' }], [{ text: 'Remove Channel' }], [{ text: 'List Channels' }], [{ text: 'Back to Admin Menu' }]];
    bot.sendMessage(msg.chat.id, 'Choose an action for Channels:', { reply_markup: { keyboard: channelAdminKeyboard, one_time_keyboard: true, resize_keyboard: true } });
});

// List Channels
bot.onText(/List Channels/, async (msg) => {
    const channels = await getChannels();
    if (channels.length === 0) {
        bot.sendMessage(msg.chat.id, 'No channels added yet.');
    } else {
        let message = "Current Channels:\n";
        channels.forEach(c => message += `- ${c.username} (${c.link})\n`);
        bot.sendMessage(msg.chat.id, message);
    }
});

// Handle Settings Menu
bot.onText(/Settings/, async (msg) => {
    const settingsKeyboard = [
        [{ text: 'Set Referral Reward' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose a setting:', {
        reply_markup: {
            keyboard: settingsKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Set Referral Reward
bot.onText(/Set Referral Reward/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_referral_reward' };
    bot.sendMessage(msg.chat.id, 'Enter the new referral reward amount (in SpyCoin):');
});

// Handle Manage Users Menu
bot.onText(/Manage Users/, async (msg) => {
    const userAdminKeyboard = [
        [{ text: 'Add/Remove User Balance' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose a user management action:', {
        reply_markup: {
            keyboard: userAdminKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Add/Remove User Balance Flow
bot.onText(/Add\/Remove User Balance/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_user_id_for_balance' };
    bot.sendMessage(msg.chat.id, 'Please enter the User ID (Chat ID) of the user whose balance you want to modify.');
});

// --- Navigation Back to Previous Menus ---
bot.onText(/Back to Source Code Admin Menu/, async (msg) => {
    // Go back to Manage Source Codes menu
    const adminMenuKeyboard = [[{ text: 'Add New Source Code' }], [{ text: 'Remove Source Code' }], [{ text: 'Back to Admin Menu' }]];
    bot.sendMessage(msg.chat.id, 'Returning to Source Code Management...', { reply_markup: { keyboard: adminMenuKeyboard, one_time_keyboard: true, resize_keyboard: true } });
});

bot.onText(/Back to Channel Admin Menu/, async (msg) => {
    // Go back to Manage Channels menu
    const channelAdminKeyboard = [[{ text: 'Add New Channel' }], [{ text: 'Remove Channel' }], [{ text: 'List Channels' }], [{ text: 'Back to Admin Menu' }]];
    bot.sendMessage(msg.chat.id, 'Returning to Channel Management...', { reply_markup: { keyboard: channelAdminKeyboard, one_time_keyboard: true, resize_keyboard: true } });
});

bot.onText(/Back to Settings/, async (msg) => {
    // Go back to Settings menu
    const settingsKeyboard = [[{ text: 'Set Referral Reward' }], [{ text: 'Back to Admin Menu' }]];
    bot.sendMessage(msg.chat.id, 'Returning to Settings...', { reply_markup: { keyboard: settingsKeyboard, one_time_keyboard: true, resize_keyboard: true } });
});

bot.onText(/Back to User Admin Menu/, async (msg) => {
    // Go back to Manage Users menu
    const userAdminKeyboard = [[{ text: 'Add/Remove User Balance' }], [{ text: 'Back to Admin Menu' }]];
    bot.sendMessage(msg.chat.id, 'Returning to User Management...', { reply_markup: { keyboard: userAdminKeyboard, one_time_keyboard: true, resize_keyboard: true } });
});

// --- General Admin Menu Navigation ---
bot.onText(/Back to Admin Menu/, async (msg) => {
    await navigateBackToAdminMenu(msg.chat.id);
});

// --- Error Handling ---
bot.on('polling_error', (error) => { console.error('Polling error:', error.code, error.message); });
bot.on('webhook_error', (error) => { console.error('Webhook error:', error.code, error.message); });
bot.on('error', (error) => { console.error('General error:', error); });


// --- Start Server and Bot ---
app.get('/admin', (req, res) => {
    res.redirect('/admin.html');
});

// Placeholder for Admin Panel POST routes if you extend admin.html
app.post('/admin/addchannel', async (req, res) => { /* ... implementation ... */ });
app.post('/admin/setreferreward', async (req, res) => { /* ... implementation ... */ });

app.listen(port, () => {
    console.log(`Express server running on port ${port}`);
});

bot.startPolling().then(() => {
    console.log('Telegram Bot is running and polling...');
}).catch(err => {
    console.error("Failed to start Telegram Bot polling:", err);
    process.exit(1);
});
