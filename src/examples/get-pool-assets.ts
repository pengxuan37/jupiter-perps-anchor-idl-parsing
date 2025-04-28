import { Connection, PublicKey } from "@solana/web3.js";
import { JUPITER_PERPETUALS_PROGRAM, JLP_POOL_ACCOUNT_PUBKEY, CUSTODY_PUBKEY } from "../constants";
import { BN } from "@coral-xyz/anchor";
import { BNToUSDRepresentation } from "../utils"; // Assuming this utility exists
import axios from 'axios';

// Define the type for the oracle price data
interface OraclePriceData {
  feedId: string;
  price: number; // This number needs to be treated as a BN
  ts: number;
  expo: number;
}

// Define a type to store asset data including quantity and USD value
interface AssetData {
    symbol: string;
    totalTokensBN: BN; // Total tokens in native units * 10^decimals
    usdValueBN: BN; // Total value in USD * 10^6 precision
    decimals: number; // Token decimals
}


/**
 * 获取Jupiter Perpetuals池中每个代币的实时规模数据和占比，
 * 使用直接的RPC调用方式和Jupiter Doves Oracle获取非稳定币价格。
 */
async function getPoolAssets() {
  try {
    // 使用GetBlock提供的RPC端点和访问令牌
    const rpcUrl = process.env.RPC_URL || "https://go.getblock.io/7e5a1f7d39454142bb8af02b51c5420b";
    const accessToken = "7e5a1f7d39454142bb8af02b51c5420b"; // 访问令牌

    console.log("正在获取Jupiter Perpetuals池数据...");

    // 1. 获取Oracle价格数据
    const oracleApiUrl = "https://worker.jup.ag/doves-oracle/btcusd,ethusd,solusd,usdcusd,usdtusd";
    let oraclePrices: { [key: string]: { price: BN, expo: number } } = {};
    const USD_PRECISION = 6; // Assuming guaranteedUsd and desired output USD value precision is 10^6

    try {
        console.log("正在获取Oracle价格...");
        const oracleResponse = await axios.get<OraclePriceData[]>(oracleApiUrl);

        if (oracleResponse.data && Array.isArray(oracleResponse.data)) {
            oracleResponse.data.forEach(feed => {
                oraclePrices[feed.feedId.replace("USD", "")] = { // Store by token symbol (BTC, ETH, SOL, USDC, USDT)
                    price: new BN(feed.price),
                    expo: feed.expo
                };
            });
            console.log("Oracle价格获取成功:", Object.keys(oraclePrices).join(", "));
        } else {
            console.warn("无法从Oracle API获取有效的价格数据.");
        }
    } catch (oracleError) {
        console.error("获取Oracle价格时出错:", oracleError instanceof Error ? oracleError.message : String(oracleError));
        // Continue execution, but calculations might be inaccurate
    }


    // 2. 获取池账户信息
    const poolAccountResponse = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [
        JLP_POOL_ACCOUNT_PUBKEY.toString(),
        {
          encoding: "base64"
        }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': accessToken
      }
    });

    if (!poolAccountResponse.data.result || !poolAccountResponse.data.result.value) {
      throw new Error("无法获取池账户数据");
    }

    // 解析池数据
    const poolAccountData = Buffer.from(poolAccountResponse.data.result.value.data[0], 'base64');
    const poolData = JUPITER_PERPETUALS_PROGRAM.coder.accounts.decode("pool", poolAccountData);

    // 获取池中的Custody账户列表
    const custodies = poolData.custodies || [];

    if (custodies.length === 0) {
      throw new Error("池中未找到任何币种");
    }

    const assetsData: AssetData[] = [];
    let totalPoolUSD_BN = new BN(0);

    console.log("\n--- JLP池子资产规模及占比 ---");

    // 逐个处理池中的Custody账户
    for (const custodyPubkey of custodies) {
      try {
        // 获取单个Custody账户数据
        const custodyResponse = await axios.post(rpcUrl, {
          jsonrpc: "2.0",
          id: 4, // Use a different ID
          method: "getAccountInfo",
          params: [
            custodyPubkey.toString(),
            {
              encoding: "base64"
            }
          ]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': accessToken
          }
        });

        if (!custodyResponse.data.result || !custodyResponse.data.result.value) {
          console.log(`无法获取 ${custodyPubkey.toString()} 的数据`);
          continue;
        }

        // 解析单个Custody数据
        const custodyAccountData = Buffer.from(custodyResponse.data.result.value.data[0], 'base64');
        const custodyData = JUPITER_PERPETUALS_PROGRAM.coder.accounts.decode("custody", custodyAccountData);

        // 获取代币符号
        let tokenSymbol = "未知";
        const decimals = custodyData.decimals || 6; // 获取代币的小数位数
        const custodyAddress = custodyPubkey.toString();

        // Map custody address to token symbol
        switch (custodyAddress) {
            case CUSTODY_PUBKEY.SOL:
                tokenSymbol = "SOL";
                break;
            case CUSTODY_PUBKEY.ETH:
                tokenSymbol = "ETH";
                break;
            case CUSTODY_PUBKEY.BTC:
                tokenSymbol = "BTC";
                break;
            case CUSTODY_PUBKEY.USDC:
                tokenSymbol = "USDC";
                break;
            case CUSTODY_PUBKEY.USDT:
                tokenSymbol = "USDT";
                break;
            default:
                tokenSymbol = custodyData.name || custodyData.symbol || custodyAddress.substring(0, 5) + "...";
        }

        // Calculate total asset quantity in native units * 10^decimals
        let totalTokensBN = new BN(0);
        const isStablecoin = tokenSymbol === "USDC" || tokenSymbol === "USDT";

        if (custodyData.assets) {
          if (isStablecoin) {
            // Stablecoin: Use owned field
            totalTokensBN = custodyData.assets.owned;
          } else {
            // Non-stablecoin: (owned-locked) + guaranteedUsd / current_price (scaled)
            const ownedMinusLocked = custodyData.assets.owned.sub(custodyData.assets.locked);

            // Get oracle price for the token
            const oraclePriceData = oraclePrices[tokenSymbol];

            if (oraclePriceData && oraclePriceData.price.gtn(0)) {
                const oraclePriceBN = oraclePriceData.price;
                const oracleExpo = oraclePriceData.expo;
                const guaranteedUsdBN: BN = custodyData.assets.guaranteedUsd || new BN(0);

                let guaranteedUsdPartInTokenUnits = new BN(0);

                if (guaranteedUsdBN.gtn(0)) {
                     // Scale guaranteedUsd (USD * 10^USD_PRECISION) to Token * 10^decimals using oracle price.
                     // guaranteedUsd / Price -> Token * 10^USD_PRECISION
                     // oraclePriceBN is Price * 10^-oracleExpo
                     // (guaranteedUsd_BN / (oraclePriceBN * 10^oracleExpo)) scaled to Token * 10^decimals
                     // guaranteedUsd_BN * 10^decimals / (oraclePriceBN * 10^oracleExpo * 10^USD_PRECISION) ??
                     // Let's use the derived formula again:
                     // guaranteedUsd_BN.mul(new BN(10).pow(new BN(decimals - (USD_PRECISION + oracleExpo)))).div(oraclePriceBN)

                     const exponentDifference = decimals - (USD_PRECISION + oracleExpo);

                     if (exponentDifference >= 0) {
                         const scaleUp = new BN(10).pow(new BN(exponentDifference));
                         guaranteedUsdPartInTokenUnits = guaranteedUsdBN.mul(scaleUp).div(oraclePriceBN);
                     } else {
                         const scaleDown = new BN(10).pow(new BN(-exponentDifference));
                         guaranteedUsdPartInTokenUnits = guaranteedUsdBN.div(oraclePriceBN.mul(scaleDown));
                     }
                }
                totalTokensBN = ownedMinusLocked.add(guaranteedUsdPartInTokenUnits);
            } else {
                 console.warn(`未找到 ${tokenSymbol} 的Oracle价格，或价格为零。使用备用计算方法 for quantity.`);
                 // Fallback for quantity calculation if oracle price is missing/zero
                 let guaranteedUsdPartFallback = new BN(0);
                  const scaleFactor = new BN(10).pow(new BN(decimals));

                  if (custodyData.assets.guaranteedUsd && custodyData.assets.globalShortAveragePrices &&
                      !custodyData.assets.globalShortAveragePrices.isZero()) {

                      guaranteedUsdPartFallback = custodyData.assets.guaranteedUsd
                                                      .mul(scaleFactor)
                                                      .div(custodyData.assets.globalShortAveragePrices);
                  }
                 totalTokensBN = ownedMinusLocked.add(guaranteedUsdPartFallback);
            }
          }
        }

        // Calculate USD value for the asset (scaled to USD_PRECISION 10^6)
        let assetUSD_BN = new BN(0);
        const oraclePriceData = oraclePrices[tokenSymbol]; // Get price data again for USD value calculation

        if (totalTokensBN.gtn(0) && oraclePriceData && oraclePriceData.price.gtn(0)) {
             const oraclePriceBN = oraclePriceData.price;
             const oracleExpo = oraclePriceData.expo;

             if (isStablecoin) {
                 // Stablecoin: totalTokensBN is USD * 10^decimals. Scale to USD * 10^USD_PRECISION
                 const exponentDifference = USD_PRECISION - decimals;
                 if (exponentDifference >= 0) {
                     assetUSD_BN = totalTokensBN.mul(new BN(10).pow(new BN(exponentDifference)));
                 } else {
                     assetUSD_BN = totalTokensBN.div(new BN(10).pow(new BN(-exponentDifference)));
                 }
             } else {
                // Non-stablecoin: totalTokensBN is Token * 10^decimals. Price is USD/Token.
                // Value = (Token * 10^decimals / 10^decimals) * Price
                // Value = totalTokens * Price
                // Value in BN (scaled to USD * 10^USD_PRECISION):
                // (totalTokensBN / 10^decimals) * (oraclePriceBN * 10^oracleExpo) * 10^USD_PRECISION
                // totalTokensBN * oraclePriceBN * 10^oracleExpo * 10^USD_PRECISION / 10^decimals
                // totalTokensBN.mul(oraclePriceBN).mul(new BN(10).pow(new BN(oracleExpo + USD_PRECISION))).div(new BN(10).pow(new BN(decimals)))
                // Simplify exponent: oracleExpo + USD_PRECISION - decimals

                 const exponentDifference = oracleExpo + USD_PRECISION - decimals;

                 if (exponentDifference >= 0) {
                     assetUSD_BN = totalTokensBN.mul(oraclePriceBN).mul(new BN(10).pow(new BN(exponentDifference)));
                 } else {
                     assetUSD_BN = totalTokensBN.mul(oraclePriceBN).div(new BN(10).pow(new BN(-exponentDifference)));
                 }
             }
        } else if (isStablecoin && totalTokensBN.gtn(0)) {
             // Fallback for stablecoin USD value if no oracle price (shouldn't happen for USDC/USDT)
             const exponentDifference = USD_PRECISION - decimals;
              if (exponentDifference >= 0) {
                 assetUSD_BN = totalTokensBN.mul(new BN(10).pow(new BN(exponentDifference)));
             } else {
                 assetUSD_BN = totalTokensBN.div(new BN(10).pow(new BN(-exponentDifference)));
             }
        }
        else {
             console.warn(`无法计算 ${tokenSymbol} 的USD价值 (数量或价格缺失)。`);
        }

        // Store asset data
        assetsData.push({
            symbol: tokenSymbol,
            totalTokensBN: totalTokensBN,
            usdValueBN: assetUSD_BN,
            decimals: decimals,
        });

        // Add to total pool USD value
        totalPoolUSD_BN = totalPoolUSD_BN.add(assetUSD_BN);

      } catch (error) {
        console.error(`处理 ${custodyPubkey.toString()} Custody时出错:`, error instanceof Error ? error.message : String(error));
      }
    }

    // Now calculate and display percentages
     if (totalPoolUSD_BN.gtn(0)) {
         console.log(`\n总资产 USD 价值: $${totalPoolUSD_BN.toNumber() / Math.pow(10, USD_PRECISION)}`); // Display total USD value (approximate)

         for (const asset of assetsData) {
             let percentage = "N/A";
             if (asset.usdValueBN.gtn(0)) {
                 // Calculate percentage: (asset.usdValueBN / totalPoolUSD_BN) * 100
                 // To get percentage with 2 decimal places, calculate (asset.usdValueBN * 10000) / totalPoolUSD_BN
                 const percentageScaled = asset.usdValueBN.mul(new BN(10000)).div(totalPoolUSD_BN);
                 percentage = (percentageScaled.toNumber() / 100).toFixed(2) + "%";
             }

             // Format asset quantity for display
             const balance = asset.totalTokensBN.toNumber() / Math.pow(10, asset.decimals);
             const balanceStr = balance.toLocaleString(undefined, { maximumFractionDigits: asset.decimals });

             console.log(`${asset.symbol}: ${balanceStr} (${percentage})`);
         }
     } else {
         console.warn("\n无法计算总资产 USD 价值，无法计算占比。");
     }


     console.log("--------------------------");
  } catch (error) {
    console.error("获取Pool资产数据时出错:", error instanceof Error ? error.message : String(error));
  }
}

// 执行函数
getPoolAssets().catch(error => {
  console.error("程序执行失败:", error instanceof Error ? error.message : String(error));
});