.PHONY: test build
PYTHON ?= python3
test:
	$(PYTHON) -m pytest
build:
	$(PYTHON) -m build
