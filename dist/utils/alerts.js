"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.crash = exports.postion = void 0;
const axios_1 = __importDefault(require("axios"));
const postion = async (symbol, pnl) => {
    try {
        await axios_1.default.post("https://discord.com/api/webhooks/1106025437798350990/EtLwku3LYvygYg4_VM1BPjqsz2LH38-5wuipwBRjJ7V1OvYCmeGQMPtgEZC_SDnzy--X", {
            avatar_url: "https://api.phantom.app/image-proxy/?image=https%3A%2F%2Farweave.net%2FY2TDaYcIsFWkPY7OSLyZ4zdPd6rzIYCxCkZVlpkY78U%3Fext%3Dpng",
            content: `**${process.env.BOT_NAME}** @here`,
            username: process.env.BOT_NAME,
            embeds: [
                {
                    title: "POSITION UPDATE",
                    description: symbol,
                    color: 0x00ff00,
                    fields: [
                        {
                            name: "PNL",
                            value: pnl.toString(),
                            inline: true,
                        },
                    ],
                },
            ],
        });
    }
    catch { }
};
exports.postion = postion;
const crash = async () => {
    await axios_1.default.post("https://discord.com/api/webhooks/1106025437798350990/EtLwku3LYvygYg4_VM1BPjqsz2LH38-5wuipwBRjJ7V1OvYCmeGQMPtgEZC_SDnzy--X", {
        avatar_url: "https://api.phantom.app/image-proxy/?image=https%3A%2F%2Farweave.net%2FY2TDaYcIsFWkPY7OSLyZ4zdPd6rzIYCxCkZVlpkY78U%3Fext%3Dpng",
        content: `**${process.env.BOT_NAME}** @here`,
        username: process.env.BOT_NAME,
        embeds: [
            {
                title: "BOT CRASHED",
                color: 0xff0000,
                fields: [],
            },
        ],
    });
};
exports.crash = crash;
