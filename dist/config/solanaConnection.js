"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connection = exports.env = void 0;
const web3_js_1 = require("@solana/web3.js");
const helius_1 = __importDefault(require("../utils/helius"));
exports.env = "mainnet-beta";
exports.connection = new web3_js_1.Connection(helius_1.default);
