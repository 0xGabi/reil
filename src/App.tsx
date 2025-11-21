import styled from 'styled-components'
import { SnackbarProvider } from 'notistack'
import { createTheme, ThemeProvider } from '@mui/material'

import { Header } from './components/header'
import { Flags } from './components/Flags.tsx'

export const App = () => {
  const darkTheme = createTheme({
    palette: {
      mode: 'dark',
    },
  })
  return (
    <ThemeProvider theme={darkTheme}>
      <SnackbarProvider maxSnack={3}>
        <Header/>
        <Container>
          <Flags/>
        </Container>
      </SnackbarProvider>
    </ThemeProvider>
  )
}

const Container = styled.div`
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    margin: auto;
    width: 100%;
    height: 100%;
    border-radius: 16px;
    padding: 8px;
`
