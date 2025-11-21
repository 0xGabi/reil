import { useMemo } from "react";
import { Button } from "@mui/material";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import styled from "styled-components";

import { formatAddress } from "../utils";

export const Header = () => {
  const { allAccounts } = useAppKitAccount();
  const { open } = useAppKit();

  const address = useMemo(() => allAccounts[0]?.address, [allAccounts]);

  return (
    <Container>
      {!address ? (
        <Button color="primary" onClick={() => open()}>
          Connect
        </Button>
      ) : (
        <Address onClick={() => open({ view: "Account" })}>{formatAddress(address)}</Address>
      )}
    </Container>
  );
};

const Container = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 16px;
  border-bottom: 1px solid gray;
`;

const Address = styled.div`
  cursor: pointer;
`;
