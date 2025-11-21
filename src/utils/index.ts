export const formatAddress = (
  address: string | undefined | null,
  startAmount: number = 6,
  endAmount: number = -4
): string => {
  if (!address) return "";

  return `${address.slice(0, startAmount)}...${address.slice(endAmount)}`;
};
