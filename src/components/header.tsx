import { useMemo } from "react";
import { Button, Typography } from "@mui/material";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import styled from "styled-components";

import { formatAddress } from "../utils";

export const Header = () => {
  const { allAccounts } = useAppKitAccount();
  const { open } = useAppKit();

  const address = useMemo(() => allAccounts[0]?.address, [allAccounts]);

  return (
    <Container>
      <LeftSection>
        <Typography variant="h5" fontWeight="bold">
          Cross-Chain Aave Rebalancer
        </Typography>
      </LeftSection>
      <RightSection>
        {!address ? (
          <Button color="primary" onClick={() => open()} size="small">
            Connect
          </Button>
        ) : (
          <Address onClick={() => open({ view: "Account" })}>{formatAddress(address)}</Address>
        )}
      </RightSection>
    </Container>
  );
};

const Container = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background-color: rgba(0, 0, 0, 0.2);
  flex-wrap: wrap;
  gap: 12px;
`;

const LeftSection = styled.div`
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  gap: 12px;
`;

const RightSection = styled.div`
  display: flex;
  align-items: center;
`;

const Address = styled.div`
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 4px;
  background-color: rgba(255, 255, 255, 0.1);
  transition: background-color 0.2s;
  &:hover {
    background-color: rgba(255, 255, 255, 0.15);
  }
`;
