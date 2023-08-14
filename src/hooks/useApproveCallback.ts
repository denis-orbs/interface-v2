import { MaxUint256 } from '@ethersproject/constants';
import { TransactionResponse } from '@ethersproject/providers';
import {
  Trade,
  TokenAmount,
  CurrencyAmount,
  ETHER,
  Fraction,
  Percent,
  ChainId,
} from '@uniswap/sdk';
import {
  CurrencyAmount as CurrencyAmountV3,
  Currency,
} from '@uniswap/sdk-core';
import { useCallback, useMemo } from 'react';
import { useTokenAllowance, useTokenAllowanceV3 } from 'data/Allowances';
import { Field } from 'state/swap/actions';
import {
  useTransactionAdder,
  useHasPendingApproval,
} from 'state/transactions/hooks';
import { computeSlippageAdjustedAmounts } from 'utils/prices';
import { calculateGasMargin, calculateGasMarginBonus } from 'utils';
import { useActiveWeb3React } from 'hooks';
import { useTokenContract } from './useContract';
import {
  PARASWAP_PROXY_ROUTER_ADDRESS,
  V2_ROUTER_ADDRESS,
  SWAP_ROUTER_ADDRESS,
} from 'constants/v3/addresses';
import { OptimalRate } from '@paraswap/sdk';
import { ONE } from 'v3lib/utils';
import {
  liquidityHubAnalytics,
  PERMIT2_ADDRESS,
  useIsApprovePermit2,
} from 'LiquidityHub';

export enum ApprovalState {
  UNKNOWN,
  NOT_APPROVED,
  PENDING,
  APPROVED,
}

// returns a variable indicating the state of the approval and a function which approves if necessary or early returns
export function useApproveCallback(
  amountToApprove?: CurrencyAmount,
  spender?: string,
): [ApprovalState, () => Promise<void>] {
  const { account, chainId } = useActiveWeb3React();
  const chainIdToUse = chainId ? chainId : ChainId.MATIC;
  const nativeCurrency = ETHER[chainIdToUse];
  const token =
    amountToApprove instanceof TokenAmount ? amountToApprove.token : undefined;
  const currentAllowance = useTokenAllowance(
    token,
    account ?? undefined,
    spender,
  );
  const pendingApproval = useHasPendingApproval(token?.address, spender);

  // check the current approval status
  const approvalState: ApprovalState = useMemo(() => {
    if (!amountToApprove || !spender) return ApprovalState.UNKNOWN;
    if (amountToApprove.currency === nativeCurrency)
      return ApprovalState.APPROVED;
    // we might not have enough data to know whether or not we need to approve
    if (!currentAllowance) return ApprovalState.UNKNOWN;

    // amountToApprove will be defined if currentAllowance is
    return currentAllowance.lessThan(amountToApprove)
      ? pendingApproval
        ? ApprovalState.PENDING
        : ApprovalState.NOT_APPROVED
      : ApprovalState.APPROVED;
  }, [
    amountToApprove,
    currentAllowance,
    nativeCurrency,
    pendingApproval,
    spender,
  ]);

  const tokenContract = useTokenContract(token?.address);
  const addTransaction = useTransactionAdder();

  const approve = useCallback(async (): Promise<void> => {
    if (approvalState !== ApprovalState.NOT_APPROVED) {
      console.error('approve was called unnecessarily');
      return;
    }
    if (!token) {
      console.error('no token');
      return;
    }

    if (!tokenContract) {
      console.error('tokenContract is null');
      return;
    }

    if (!amountToApprove) {
      console.error('missing amount to approve');
      return;
    }

    if (!spender) {
      console.error('no spender');
      return;
    }

    let useExact = false;
    const estimatedGas = await tokenContract.estimateGas
      .approve(spender, MaxUint256)
      .catch(() => {
        // general fallback for tokens who restrict approval amounts
        useExact = true;
        return tokenContract.estimateGas.approve(
          spender,
          amountToApprove.raw.toString(),
        );
      });

    return tokenContract
      .approve(
        spender,
        useExact ? amountToApprove.raw.toString() : MaxUint256,
        {
          gasLimit: calculateGasMargin(estimatedGas),
        },
      )
      .then(async (response: TransactionResponse) => {
        addTransaction(response, {
          summary: 'Approve ' + amountToApprove.currency.symbol,
          approval: { tokenAddress: token.address, spender: spender },
        });
        try {
          await response.wait();
        } catch (e) {
          console.debug('Failed to approve token', e);
          throw e;
        }
      })
      .catch((error: Error) => {
        console.debug('Failed to approve token', error);
        throw error;
      });
  }, [
    approvalState,
    token,
    tokenContract,
    amountToApprove,
    spender,
    addTransaction,
  ]);

  return [approvalState, approve];
}

// returns a variable indicating the state of the approval and a function which approves if necessary or early returns
export function useApproveCallbackV3(
  amountToApprove?: CurrencyAmountV3<Currency>,
  spender?: string,
  isBonusRoute?: boolean,
  callbacks?: {
    onApprove?: (spender: string, amount: string) => void;
    onApproveError?: (error: string) => void;
  },
): [ApprovalState, () => Promise<void>] {
  const { account, chainId } = useActiveWeb3React();
  const token = amountToApprove?.currency?.isToken
    ? amountToApprove.currency
    : undefined;
  const currentAllowance = useTokenAllowanceV3(
    token,
    account ?? undefined,
    spender,
  );
  const pendingApproval = useHasPendingApproval(token?.address, spender);

  // check the current approval status
  const approvalState: ApprovalState = useMemo(() => {
    if (!amountToApprove || !spender) return ApprovalState.UNKNOWN;
    if (amountToApprove.currency.isNative) return ApprovalState.APPROVED;
    // we might not have enough data to know whether or not we need to approve
    if (!currentAllowance) return ApprovalState.UNKNOWN;

    // amountToApprove will be defined if currentAllowance is
    return currentAllowance.lessThan(amountToApprove)
      ? pendingApproval
        ? ApprovalState.PENDING
        : ApprovalState.NOT_APPROVED
      : ApprovalState.APPROVED;
  }, [amountToApprove, currentAllowance, pendingApproval, spender]);

  const tokenContract = useTokenContract(token?.address);
  const addTransaction = useTransactionAdder();

  const approve = useCallback(async (): Promise<void> => {
    if (approvalState !== ApprovalState.NOT_APPROVED) {
      console.error('approve was called unnecessarily');
      return;
    }
    if (!chainId) {
      console.error('no chainId');
      return;
    }

    if (!token) {
      console.error('no token');
      return;
    }

    if (!tokenContract) {
      console.error('tokenContract is null');
      return;
    }

    if (!amountToApprove) {
      console.error('missing amount to approve');
      return;
    }

    if (!spender) {
      console.error('no spender');
      return;
    }

    let useExact = false;
    callbacks?.onApprove?.(spender, amountToApprove.toFixed(4));

    const estimatedGas = await tokenContract.estimateGas
      .approve(spender, MaxUint256)
      .catch(() => {
        // general fallback for tokens who restrict approval amounts
        useExact = true;
        return tokenContract.estimateGas.approve(
          spender,
          amountToApprove.quotient.toString(),
        );
      });
    return tokenContract
      .approve(
        spender,
        useExact ? amountToApprove.quotient.toString() : MaxUint256,
        {
          gasLimit: isBonusRoute
            ? calculateGasMarginBonus(estimatedGas)
            : calculateGasMargin(estimatedGas),
        },
      )
      .then((response: TransactionResponse) => {
        addTransaction(response, {
          summary: 'Approve ' + amountToApprove.currency.symbol,
          approval: { tokenAddress: token.address, spender: spender },
        });
      })
      .catch((error: Error) => {
        callbacks?.onApproveError?.(error.message);
        console.debug('Failed to approve token', error);
        // throw error
      });
  }, [
    approvalState,
    token,
    tokenContract,
    amountToApprove,
    spender,
    addTransaction,
    chainId,
    isBonusRoute,
    callbacks,
  ]);

  return [approvalState, approve];
}

// wraps useApproveCallback in the context of a swap
export function useApproveCallbackFromTrade(
  trade?: Trade,
  allowedSlippage = 0,
): [ApprovalState, () => Promise<void>] {
  const { chainId } = useActiveWeb3React();
  const amountToApprove = useMemo(
    () =>
      trade
        ? computeSlippageAdjustedAmounts(trade, allowedSlippage)[Field.INPUT]
        : undefined,
    [trade, allowedSlippage],
  );

  return useApproveCallback(
    amountToApprove,
    chainId ? V2_ROUTER_ADDRESS[chainId] : undefined,
  );
}

// wraps useApproveCallback in the context of a swap
export function useApproveCallbackFromBestTrade(
  allowedSlippage: Percent,
  currency?: Currency,
  optimalRate?: OptimalRate,
  bonusRouteFound?: boolean,
  atMaxAmountInput?: boolean,
): [ApprovalState, () => Promise<void>] {
  const { chainId } = useActiveWeb3React();
  const approvePermit2 = useIsApprovePermit2();

  const amountToApprove = useMemo(
    () =>
      optimalRate
        ? atMaxAmountInput
          ? new Fraction(ONE).multiply(optimalRate.srcAmount).quotient
          : new Fraction(ONE)
              .add(allowedSlippage)
              .multiply(optimalRate.srcAmount).quotient
        : undefined,
    [optimalRate, allowedSlippage, atMaxAmountInput],
  );

  return useApproveCallbackV3(
    amountToApprove && currency
      ? CurrencyAmountV3.fromRawAmount(currency, amountToApprove)
      : undefined,
    approvePermit2
      ? PERMIT2_ADDRESS
      : chainId
      ? bonusRouteFound
        ? SWAP_ROUTER_ADDRESS[chainId]
        : PARASWAP_PROXY_ROUTER_ADDRESS[chainId]
      : undefined,
    bonusRouteFound,
    {
      onApprove: (spender, amount) =>
        liquidityHubAnalytics.onApproveRequest(spender, amount),
      onApproveError: (error) => liquidityHubAnalytics.onApproveFailed(error),
    },
  );
}

// todo change to permit2
