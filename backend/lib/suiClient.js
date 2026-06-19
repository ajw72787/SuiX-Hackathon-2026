import axios from 'axios';

const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

export async function getCoinMetadata(coinType) {
    const response = await axios.post(
        SUI_RPC_URL,
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'suix_getCoinMetadata',
            params: [coinType]
        },
        { headers: { 'Content-Type': 'application/json' } }
    );

    return response.data?.result || null;
}

export async function getWalletBalances(address) {
    const response = await axios.post(
        SUI_RPC_URL,
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'suix_getAllBalances',
            params: [address]
        },
        { headers: { 'Content-Type': 'application/json' } }
    );

    return response.data?.result || [];
}

export default { getCoinMetadata, getWalletBalances };
