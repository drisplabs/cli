import {createContext, useContext} from 'react';
import {type Theme} from '../../shared/types/theme';
import {darkTheme} from './themes';

const ThemeContext = createContext<Theme>(darkTheme);

export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): Theme {
	return useContext(ThemeContext);
}
