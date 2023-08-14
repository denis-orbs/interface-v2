import React, { useEffect, useMemo } from 'react';
import Web3 from 'web3';
import BN from 'bignumber.js';
import {
  useLiquidityHubManager,
  useUserSlippageTolerance,
} from 'state/user/hooks';
import { useActiveWeb3React } from 'hooks';
import { useLocation } from 'react-router-dom';
import { styled } from '@material-ui/styles';
import { Box } from '@material-ui/core';
import OrbsLogo from 'assets/images/orbs-logo.svg';
import { setWeb3Instance, signEIP712 } from '@defi.org/web3-candies';
import { useTranslation } from 'react-i18next';
import {
  useLiquidityHubActionHandlers,
  useLiquidityHubState,
} from 'state/swap/liquidity-hub/hooks';
import { ApprovalState } from 'hooks/useApproveCallback';
const API_ENDPOINT = 'https://hub.orbs.network';
export const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const WEBSITE = 'https://www.orbs.com';

export const useLiquidityHubCallback = () => {
  const [liquidityHubDisabled] = useLiquidityHubManager();
  const { account, library } = useActiveWeb3React();
  const liquidityHubState = useLiquidityHubState();
  const { onSetLiquidityHubState } = useLiquidityHubActionHandlers();
  const { t } = useTranslation();
  const {
    forceParaswapTrade,
    forceLiquidityHubTrade,
  } = useForceTradeFromQueryParam();

  return async ({
    destToken,
    maxSrcAmount,
    srcToken,
    minDestAmount,
  }: {
    minDestAmount: string;
    maxSrcAmount: string;
    srcToken: string;
    destToken: string;
  }) => {
    if (liquidityHubDisabled) {
      liquidityHubAnalytics.onDisabled();
    }
    if (
      liquidityHubDisabled ||
      !library ||
      !account ||
      forceParaswapTrade ||
      (liquidityHubState.isFailed && !forceLiquidityHubTrade)
    ) {
      return undefined;
    }
    onSetLiquidityHubState({
      isLoading: true,
      liquidityHubTrade: false,
      isFailed: false,
      amountOut: undefined,
    });

    try {
      const { permitData, serializedOrder, callData, outAmount } = await quote({
        destToken,
        maxSrcAmount,
        srcToken,
        minDestAmount,
        account,
        forceLiquidityHubTrade,
      });

      onSetLiquidityHubState({
        liquidityHubTrade: true,
        isLoading: false,
        amountOut: outAmount,
      });
      const signature = await sign(account, library, permitData);
      const txHash = await swap({
        account,
        srcToken,
        destToken,
        maxSrcAmount,
        minDestAmount,
        signature,
        serializedOrder,
        callData,
      });
      const tx = await waitForTx(txHash, library);
      if (!tx) {
        throw new Error('Missing tx');
      }

      return tx;
    } catch (error) {
      onSetLiquidityHubState({
        liquidityHubTrade: false,
        isFailed: true,
        isLoading: false,
        amountOut: undefined,
      });
      throw new Error(t('liquidityHubFailed'));
    } finally {
      onSetLiquidityHubState({
        isLoading: false,
      });
    }
  };
};

const sign = async (account: string, library: any, permitData: any) => {
  try {
    liquidityHubAnalytics.onSignatureRequest();
    setWeb3Instance(new Web3(library.provider as any));
    const signature = await signEIP712(account, permitData);
    liquidityHubAnalytics.onSignatureSuccess(signature);
    return signature;
  } catch (error) {
    liquidityHubAnalytics.onSignatureFailed(error.message);
    throw new Error(error.message);
  }
};

const swap = async (args: {
  account: string;
  srcToken: string;
  destToken: string;
  maxSrcAmount: string;
  minDestAmount: string;
  signature: string;
  serializedOrder: string;
  callData: string;
}) => {
  try {
    const count = counter();
    liquidityHubAnalytics.onSwapRequest();
    const txHashResponse = await fetch(`${API_ENDPOINT}/swapx?chainId=137`, {
      method: 'POST',
      body: JSON.stringify({
        inToken: args.srcToken,
        outToken: args.destToken,
        inAmount: args.maxSrcAmount,
        outAmount: args.minDestAmount,
        user: args.account,
        signature: args.signature,
        serializedOrder: args.serializedOrder,
        fillerCallData: args.callData,
      }),
    });
    const swap = await txHashResponse.json();
    if (!swap || !swap.txHash) {
      throw new Error('Missing txHash');
    }

    liquidityHubAnalytics.onSwapSuccess(swap.txHash, count());
    return swap.txHash;
  } catch (error) {
    liquidityHubAnalytics.onSwapFailed(error.message);
    throw new Error(error.message);
  }
};

const quote = async ({
  destToken,
  maxSrcAmount,
  srcToken,
  minDestAmount,
  account,
  forceLiquidityHubTrade,
}: {
  minDestAmount: string;
  maxSrcAmount: string;
  srcToken: string;
  destToken: string;
  account: string;
  forceLiquidityHubTrade: boolean;
}) => {
  try {
    liquidityHubAnalytics.onQuoteRequest(minDestAmount);
    const count = counter();
    const response = await fetch(`${API_ENDPOINT}/quote?chainId=137`, {
      method: 'POST',
      body: JSON.stringify({
        inToken: srcToken,
        outToken: destToken,
        inAmount: maxSrcAmount,
        outAmount: minDestAmount,
        user: account,
      }),
    });
    const result = await response.json();

    if (!result) {
      throw new Error('Missing result');
    }

    liquidityHubAnalytics.onQuoteSuccess(
      result.outAmount,
      result.serializedOrder,
      result.callData,
      result.permitData,
      count(),
    );

    if (
      !forceLiquidityHubTrade &&
      BN(result.outAmount).isLessThan(BN(minDestAmount))
    ) {
      const error = 'Dex trade is better than LiquidityHub trade';
      liquidityHubAnalytics.onClobLowAmountOut();
      throw new Error(error);
    }

    return {
      outAmount: result.outAmount,
      permitData: result.permitData,
      serializedOrder: result.serializedOrder,
      callData: result.callData,
    };
  } catch (error) {
    liquidityHubAnalytics.onQuoteFailed(error.message);
    throw new Error(error.message);
  }
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTx(txHash: string, library: any) {
  for (let i = 0; i < 60; ++i) {
    console.log('waitForTx', txHash, i);

    await delay(1500);
    const tx = await library.getTransaction(txHash);
    if (tx) {
      return tx;
    }
  }
}

export const useForceTradeFromQueryParam = () => {
  const location = useLocation();

  const query = useMemo(() => new URLSearchParams(location.search), [
    location.search,
  ]);

  return {
    forceLiquidityHubTrade: query.get('liquidity-hub') === '1',
    forceParaswapTrade: query.get('liquidity-hub') === '2',
  };
};

export const useIsApprovePermit2 = () => {
  const state = useLiquidityHubState();

  const { forceParaswapTrade } = useForceTradeFromQueryParam();
  const [isLiquidityHubDisabled] = useLiquidityHubManager();

  return forceParaswapTrade
    ? false
    : !isLiquidityHubDisabled && !state?.isFailed;
};

export const LiquidityHubTxSettings = () => {
  const { t } = useTranslation();
  return (
    <StyledLiquidityHubTxSettings>
      <p>{t('disableLiquidityHub')}</p>
      <p className='bottom-text'>
        <img src={OrbsLogo} />
        <a target='_blank' rel='noreferrer' href={`${WEBSITE}/liquidity-hub`}>
          {t('liquidityHub')}
        </a>
        , {t('poweredBy').toLowerCase()}{' '}
        <a href={WEBSITE} target='_blank' rel='noreferrer'>
          Orbs
        </a>
        , {t('aboutLiquidityHub')}{' '}
        <a
          className='more-info'
          href={`${WEBSITE}/liquidity-hub`}
          target='_blank'
          rel='noreferrer'
        >
          {t('forMoreInfo')}
        </a>
      </p>
    </StyledLiquidityHubTxSettings>
  );
};

export const LiquidityHubConfirmationModalContent = ({
  txPending,
}: {
  txPending?: boolean;
}) => {
  const { t } = useTranslation();
  const liquidityHubState = useLiquidityHubState();

  if (!liquidityHubState?.liquidityHubTrade || txPending) {
    return null;
  }
  return (
    <StyledLiquidityHubTrade>
      <span>{t('using')}</span>{' '}
      <a href='orbs.com/liquidity-hub' target='_blank' rel='noreferrer'>
        {t('liquidityHub')}
      </a>{' '}
      {t('by')}{' '}
      <a href={WEBSITE} target='_blank' rel='noreferrer'>
        Orbs
        <img src={OrbsLogo} />
      </a>
    </StyledLiquidityHubTrade>
  );
};

// styles
const StyledLiquidityHubTrade = styled('p')({
  '& a': {
    textDecoration: 'none',
    display: 'inline-flex',
    gap: 5,
    fontWeight: 600,
    color: 'white',
    '&:hover': {
      textDecoration: 'underline',
    },
  },
  '& span': {
    textTransform: 'capitalize',
    fontSize: 'inherit',
  },
  '& img': {
    width: 22,
    height: 22,
    objectFit: 'contain',
  },
});

const StyledLiquidityHubTxSettings = styled(Box)({
  display: 'flex',
  flexDirection: 'column',
  '& .bottom-text': {
    maxWidth: 500,
    fontSize: 14,
    lineHeight: '23px',
    '& img': {
      width: 22,
      height: 22,
      marginRight: 8,
      position: 'relative',
      top: 6,
    },
    '& a': {
      textDecoration: 'none',
      fontWeight: 600,
      color: '#6381e9',
      '&:hover': {
        textDecoration: 'underline',
      },
    },
    '& .more-info': {
      color: 'inherit',
      fontWeight: 400,
      textDecoration: 'underline',
    },
  },
});

interface State {
  state: string;
  time: number;
}
interface LiquidityHubAnalyticsData {
  _id: string;
  state: State;
  walletAddress?: string;
  srcTokenAddress: string;
  srcTokenSymbol: string;
  dstTokenAddress: string;
  dstTokenSymbol: string;
  srcAmount: string;
  dstAmountOut: string;
  clobOutAmount: string;
  approvalAmount: string;
  approvalSpender: string;
  approveFailedError: string;
  clobAmountOut: string;
  dexAmountOut: string;
  isClobTrade: boolean;
  quoteFailedError: string;
  quoteRequestDurationMillis: number;
  swapTxHash: string;
  swapFailedError: string;
  signature: string;
  serializedOrder: string;
  callData: string;
  permitData: string;
  signatureFailedError: string;
  swapRequestDurationMillis: number;
}

const counter = () => {
  const now = Date.now();

  return () => {
    return Date.now() - now;
  };
};

class LiquidityHubAnalytics {
  history: State[] = [];
  initialTimestamp = Date.now();
  data = { _id: crypto.randomUUID() } as LiquidityHubAnalyticsData;
  //counter

  private update({
    newState,
    values = {},
  }: {
    newState: string;
    values?: Partial<LiquidityHubAnalyticsData>;
  }) {
    if (this.data.state) {
      this.history.push(this.data.state);
    }

    this.data.state = {
      state: newState,
      time: Date.now() - this.initialTimestamp,
    };
    this.data = { ...this.data, ...values };

    fetch('https://bi.orbs.network/putes/clob-dev-ui', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...this.data, history: this.history }),
    }).catch();
  }

  onWalletConnected(walletAddress?: string) {
    this.update({
      newState: 'walletConnected',
      values: { walletAddress },
    });
  }

  onSrcToken(srcTokenAddress: string, srcTokenSymbol: string) {
    this.update({
      newState: 'srcToken',
      values: { srcTokenAddress, srcTokenSymbol },
    });
  }

  onDstToken(dstTokenAddress: string, dstTokenSymbol: string) {
    this.update({
      newState: 'dstToken',
      values: { dstTokenAddress, dstTokenSymbol },
    });
  }

  onDisabled() {
    this.update({
      newState: 'clobDisabled',
    });
  }

  onSrcAmount(srcAmount: string) {
    this.update({
      newState: 'srcAmount',
      values: { srcAmount },
    });
  }

  onPageLoaded() {
    this.update({
      newState: 'swapPageLoaded',
    });
  }

  onApproveRequest(approvalSpender: string, approvalAmount: string) {
    this.update({
      newState: 'approveRequest',
      values: {
        approvalSpender,
        approvalAmount,
        approveFailedError: '',
      },
    });
  }

  onTokenApproved() {
    this.update({
      newState: 'approved',
    });
  }

  onApproveFailed(approveFailedError: string) {
    this.update({
      newState: 'approveFailed',
      values: { approveFailedError },
    });
  }

  onSwapClick() {
    this.update({
      newState: 'swapClick',
    });
  }

  onConfirmSwapClick() {
    this.update({
      newState: 'swapConfirmClick',
    });
  }

  onQuoteRequest(dexAmountOut: string) {
    this.update({
      newState: 'quoteRequest',
      values: {
        dexAmountOut,
        quoteFailedError: '',
      },
    });
  }

  onQuoteSuccess(
    clobAmountOut: string,
    serializedOrder: string,
    callData: string,
    permitData: any,
    quoteRequestDurationMillis: number,
  ) {
    this.update({
      newState: 'quoteSuccess',
      values: {
        clobAmountOut,
        quoteRequestDurationMillis,
        isClobTrade: BN(this.data.dexAmountOut).isLessThan(BN(clobAmountOut)),
        serializedOrder,
        callData,
        permitData,
      },
    });
  }
  onQuoteFailed(quoteFailedError: string) {
    this.update({
      newState: 'quoteFailed',
      values: {
        quoteFailedError,
      },
    });
  }

  onClobLowAmountOut() {
    this.update({
      newState: 'clobLowAmountOut',
    });
  }

  onSignatureRequest() {
    this.update({
      newState: 'signatureRequest',
    });
  }
  onSignatureSuccess(signature: string) {
    this.update({
      newState: 'signatureSuccess',
      values: { signature },
    });
  }

  onSignatureFailed(signatureFailedError: string) {
    this.update({
      newState: 'signatureFailed',
      values: { signatureFailedError },
    });
  }

  onSwapRequest() {
    this.update({
      newState: 'swapRequest',
      values: { swapFailedError: '' },
    });
  }

  onSwapSuccess(swapTxHash: string, swapRequestDurationMillis: number) {
    this.update({
      newState: 'swapSuccess',
      values: { swapTxHash, swapRequestDurationMillis },
    });
  }

  onSwapFailed(swapFailedError: string) {
    this.update({
      newState: 'swapFailed',
      values: { swapFailedError },
    });
  }
}
export const liquidityHubAnalytics = new LiquidityHubAnalytics();

export const useLiquidityHubAnalyticsListeners = (
  approval: ApprovalState,
  showConfirm: boolean,
  attemptingTxn: boolean,
  srcToken?: any,
  dstToken?: any,
  srcAmount?: string,
) => {
  const { account } = useActiveWeb3React();

  useEffect(() => {
    if (srcAmount) {
      liquidityHubAnalytics.onSrcAmount(srcAmount);
    }
  }, [srcAmount]);

  useEffect(() => {
    if (showConfirm) {
      liquidityHubAnalytics.onSwapClick();
    }
  }, [showConfirm]);

  useEffect(() => {
    if (attemptingTxn) {
      liquidityHubAnalytics.onSwapRequest();
    }
  }, [attemptingTxn]);

  useEffect(() => {
    liquidityHubAnalytics.onWalletConnected(account);
  }, [account]);

  useEffect(() => {
    liquidityHubAnalytics.onPageLoaded();
  }, []);

  useEffect(() => {
    if (approval === ApprovalState.APPROVED) {
      liquidityHubAnalytics.onTokenApproved();
    }
  }, [approval]);

  useEffect(() => {
    liquidityHubAnalytics.onSrcToken(srcToken?.address, srcToken?.symbol);
  }, [srcToken?.address, srcToken?.symbol]);

  useEffect(() => {
    liquidityHubAnalytics.onDstToken(dstToken?.address, dstToken?.symbol);
  }, [dstToken?.address, dstToken?.symbol]);
};
