import { Box, CircularProgress } from '@mui/material';
import { SxProps, Theme } from '@mui/system';
import React, { FunctionComponent } from 'react';

const styles: Record<string, SxProps<Theme>> = {
  root: {
    marginBottom: 3,
    display: 'flex',
    justifyContent: 'space-evenly',
  },
};

interface LoaderProps {
  loading: boolean;
  sx?: SxProps<Theme>;
}

const Loader: FunctionComponent<LoaderProps> = ({ loading, sx = {} }) => {
  return loading ? (
    <Box sx={{ ...styles.root, ...sx }}>
      <CircularProgress />
    </Box>
  ) : null;
};

export default Loader;
